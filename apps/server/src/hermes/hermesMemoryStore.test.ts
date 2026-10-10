// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import {
  applyHermesMemoryMutation,
  memoryChars,
  mutateHermesMemory,
  parseHermesMemory,
  parseHermesMemoryLimits,
  readHermesMemoryFiles,
  resolveHermesMemoryPaths,
  serializeHermesMemory,
} from "./hermesMemoryStore.ts";

const fixture = NodeURL.fileURLToPath(new URL("./fixtures/hermes-memory/", import.meta.url));
const mutateForTest = (input: Parameters<typeof mutateHermesMemory>[2]) =>
  mutateHermesMemory(environment, "hermes", input, HostProcess.Platform.defaultValue());
let home: string;
let environment: NodeJS.ProcessEnv;
beforeEach(async () => {
  home = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "hermes-memory-"));
  environment = { ...process.env, HERMES_HOME: home };
});
afterEach(async () => {
  await NodeFSP.rm(home, { recursive: true, force: true });
});

async function seed(memory = "First note\n§\nSecond note", config = "") {
  await NodeFSP.mkdir(NodePath.join(home, "memories"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(home, "memories/MEMORY.md"), memory);
  await NodeFSP.writeFile(NodePath.join(home, "config.yaml"), config);
  return (await readHermesMemoryFiles(environment)).files[0]!;
}

describe("Hermes 0.21.0 memory format", () => {
  // Sanitized copies from Hermes 0.21.0: hostnames, addresses, account IDs, and repository replaced.
  it("round-trips sanitized real MEMORY.md and USER.md through Hermes canonical serialization", async () => {
    await NodeFSP.cp(fixture, home, { recursive: true });
    const { files } = await readHermesMemoryFiles(environment);
    expect(files.map((file) => file.entries.length)).toEqual([14, 8]);
    for (const file of files) {
      const raw = await NodeFSP.readFile(
        NodePath.join(home, "memories", file.target === "memory" ? "MEMORY.md" : "USER.md"),
        "utf8",
      );
      expect(file.error).toBeNull();
      // Markdown formatting adds a final newline; Hermes strips outer whitespace.
      expect(serializeHermesMemory(file.entries)).toBe(raw.trim());
      expect(file.charsUsed).toBe(Array.from(raw.trim()).length);
    }
  });

  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "resolves an instance HOME without falling back to the server user's store",
    async () => {
      const selected = { ...environment, HERMES_HOME: "", HOME: home };
      const expected = NodePath.join(home, ".hermes");
      expect(resolveHermesMemoryPaths(selected).home).toBe(expected);
      expect((await readHermesMemoryFiles(selected)).files[0]?.entries).toEqual([]);
      await expect(NodeFSP.stat(expected)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("preserves multiline notes and bare section signs, normalizes BOM and CRLF, deduplicates like Hermes", () => {
    expect(parseHermesMemory("﻿One\r\ncontinued § sign\r\n§\r\nTwo\r\n§\r\nTwo\r\n", 2200)).toEqual({
      entries: ["One\ncontinued § sign", "Two"],
      error: null,
    });
    expect(parseHermesMemory("\n  ", 2200)).toEqual({ entries: [], error: null });
  });

  it("reports lossy round trips and overlong foreign entries instead of permitting edits", () => {
    expect(parseHermesMemory("First\n§\n\n§\nSecond", 2200).error).not.toBeNull();
    expect(parseHermesMemory("First \n§\nSecond", 2200).error).not.toBeNull();
    expect(parseHermesMemory("too long", 2).error).not.toBeNull();
  });

  it("uses code points and counts the full delimiter, including at the exact cap", async () => {
    expect(memoryChars(["🙂", "𐐀"])).toBe(5);
    const file = await seed("🙂", "memory:\n  memory_char_limit: 5\n");
    expect(
      applyHermesMemoryMutation(file, {
        target: "memory",
        revision: file.revision,
        action: "add",
        content: "𐐀",
      }),
    ).toEqual(["🙂", "𐐀"]);
    expect(() =>
      applyHermesMemoryMutation(file, {
        target: "memory",
        revision: file.revision,
        action: "add",
        content: "𐐀x",
      }),
    ).toThrow(/5 characters/);
    expect(() =>
      applyHermesMemoryMutation(file, {
        target: "memory",
        revision: file.revision,
        action: "replace",
        oldText: "🙂",
        content: "123456",
      }),
    ).toThrow(/5 characters/);
  });

  it("honors top-level built-in limits and rejects broken YAML or invalid caps", () => {
    expect(parseHermesMemoryLimits("")).toEqual({ memory: 2200, user: 1375 });
    expect(
      parseHermesMemoryLimits('memory:\n  memory_char_limit: "17"\n  user_char_limit: 9\n'),
    ).toEqual({ memory: 17, user: 9 });
    expect(parseHermesMemoryLimits("memory: disabled\n")).toEqual({ memory: 2200, user: 1375 });
    expect(() => parseHermesMemoryLimits("memory: [")).toThrow();
    expect(() => parseHermesMemoryLimits("memory:\n  memory_char_limit: impossible")).toThrow();
    expect(() => parseHermesMemoryLimits("memory:\n  memory_char_limit: -1")).toThrow();
  });

  it("matches Hermes's PyYAML merge keys and YAML 1.1 numeric syntax", () => {
    expect(
      parseHermesMemoryLimits("memory:\n  <<: {memory_char_limit: 5}\n  user_char_limit: 010\n"),
    ).toEqual({ memory: 5, user: 8 });
    expect(() => parseHermesMemoryLimits("memory:\n  memory_char_limit: null\n")).toThrow();
  });

  it("refuses entries that would shift adjacent entry boundaries", async () => {
    const file = await seed("A\n§\nB");
    expect(() =>
      applyHermesMemoryMutation(file, {
        target: "memory",
        revision: file.revision,
        action: "replace",
        oldText: "A",
        content: "C\n§",
      }),
    ).toThrow(/entry boundaries/);
    expect(() =>
      applyHermesMemoryMutation(file, {
        target: "memory",
        revision: file.revision,
        action: "replace",
        oldText: "A",
        content: "\ufeffC",
      }),
    ).toThrow(/entry boundaries/);
  });

  it("never saves a character-valid file that exceeds the reader's byte safety bound", async () => {
    const file = await seed("", "memory:\n  memory_char_limit: 300000\n");
    expect(() =>
      applyHermesMemoryMutation(file, {
        target: "memory",
        revision: file.revision,
        action: "add",
        content: "🙂".repeat(262145),
      }),
    ).toThrow(/1 MiB/);
  });

  it("allows removing notes while over the total cap, but never appends a delimiter as content", async () => {
    const file = await seed("1234\n§\n5678", "memory:\n  memory_char_limit: 5\n");
    expect(file.error).toBeNull();
    expect(
      applyHermesMemoryMutation(file, {
        target: "memory",
        revision: file.revision,
        action: "remove",
        oldText: "1234",
      }),
    ).toEqual(["5678"]);
    for (const content of ["  ", "one\n§\ntwo", "\ud800"]) {
      expect(() =>
        applyHermesMemoryMutation(file, {
          target: "memory",
          revision: file.revision,
          action: "add",
          content,
        }),
      ).toThrow(/non-empty UTF-8/);
    }
  });
});

describe("locked atomic memory writes", () => {
  it("collapses a replacement onto an existing entry and checks the cap against the result", async () => {
    // Counting the duplicate would be 7 + 3 + 7 = 17 > 16; the canonical result is 7.
    const file = await seed("xy\n§\nabcdefg", "memory:\n  memory_char_limit: 16\n");
    expect(
      applyHermesMemoryMutation(file, {
        target: "memory",
        revision: file.revision,
        action: "replace",
        oldText: "xy",
        content: "abcdefg",
      }),
    ).toEqual(["abcdefg"]);
  });

  it("adds, replaces, removes, and creates a missing target without affecting the other file", async () => {
    let file = await seed();
    const oldHandle = await NodeFSP.open(resolveHermesMemoryPaths(environment).memory, "r");
    try {
      await mutateForTest({
        target: "memory",
        revision: file.revision,
        action: "add",
        content: "  A new note  ",
      });
      expect(await oldHandle.readFile("utf8")).toBe("First note\n§\nSecond note");
    } finally {
      await oldHandle.close();
    }
    file = (await readHermesMemoryFiles(environment)).files[0]!;
    expect(file.entries).toEqual(["First note", "Second note", "A new note"]);
    await mutateForTest({
      target: "memory",
      revision: file.revision,
      action: "replace",
      oldText: "A new note",
      content: "Updated note",
    });
    file = (await readHermesMemoryFiles(environment)).files[0]!;
    await mutateForTest({
      target: "memory",
      revision: file.revision,
      action: "remove",
      oldText: "Second note",
    });
    const user = (await readHermesMemoryFiles(environment)).files[1]!;
    await mutateForTest({
      target: "user",
      revision: user.revision,
      action: "add",
      content: "Prefers short answers",
    });
    expect((await readHermesMemoryFiles(environment)).files.map((file) => file.entries)).toEqual([
      ["First note", "Updated note"],
      ["Prefers short answers"],
    ]);
    expect((await NodeFSP.readdir(NodePath.join(home, "memories"))).sort()).toEqual([
      "MEMORY.md",
      "MEMORY.md.lock",
      "USER.md",
      "USER.md.lock",
    ]);
  });

  it("writes UTF-8 independently of Python's inherited locale or stdio encoding", async () => {
    const file = await seed("Café\n§\n日本語");
    await mutateHermesMemory(
      { ...environment, PYTHONIOENCODING: "cp1252" },
      "hermes",
      { target: "memory", revision: file.revision, action: "add", content: "🙂" },
      HostProcess.Platform.defaultValue(),
    );
    expect(await NodeFSP.readFile(resolveHermesMemoryPaths(environment).memory, "utf8")).toBe(
      "Café\n§\n日本語\n§\n🙂",
    );
  });

  it("rejects a stale editor and simultaneous writers instead of clobbering", async () => {
    const file = await seed();
    const results = await Promise.allSettled(
      ["A", "B"].map((content) =>
        mutateForTest({ target: "memory", revision: file.revision, action: "add", content }),
      ),
    );
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    await expect(
      mutateForTest({
        target: "memory",
        revision: file.revision,
        action: "remove",
        oldText: "First note",
      }),
    ).rejects.toMatchObject({ reason: "conflict" });
  });

  it("binds revisions to the home even when both homes contain identical notes", async () => {
    const file = await seed();
    const other = NodePath.join(home, "other-home");
    await NodeFSP.mkdir(NodePath.join(other, "memories"), { recursive: true });
    await NodeFSP.writeFile(
      NodePath.join(other, "memories/MEMORY.md"),
      "First note\n§\nSecond note",
    );
    await expect(
      mutateHermesMemory(
        { ...environment, HERMES_HOME: other },
        "hermes",
        {
          target: "memory",
          revision: file.revision,
          action: "add",
          content: "Wrong store",
        },
        HostProcess.Platform.defaultValue(),
      ),
    ).rejects.toMatchObject({ reason: "conflict" });
  });

  it("respects Hermes's flock / msvcrt lock on the sibling .lock file", async () => {
    const file = await seed();
    const lockPath = `${resolveHermesMemoryPaths(environment).memory}.lock`;
    const python = HostProcess.Platform.defaultValue() === "win32" ? "python" : "python3";
    const child = NodeChildProcess.spawn(
      python,
      [
        "-u",
        "-c",
        `import os, sys\nf = open(sys.argv[1], 'a+')\nif os.name == 'nt':\n import msvcrt\n msvcrt.locking(f.fileno(), msvcrt.LK_LOCK, 1)\nelse:\n import fcntl\n fcntl.flock(f, fcntl.LOCK_EX)\nprint('locked', flush=True)\nsys.stdin.read()\nf.close()`,
        lockPath,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const exited = new Promise<void>((resolve, reject) => {
      child.once("close", () => resolve());
      child.once("error", reject);
    });
    try {
      await Promise.race([
        new Promise<void>((resolve) => child.stdout.once("data", () => resolve())),
        exited.then(() => {
          throw new Error("Python lock holder exited before acquiring the lock");
        }),
      ]); // lock-acquired receipt, not a timed sleep
      await expect(
        mutateForTest({
          target: "memory",
          revision: file.revision,
          action: "add",
          content: "Must wait",
        }),
      ).rejects.toMatchObject({ reason: "conflict" });
      expect(await NodeFSP.readFile(resolveHermesMemoryPaths(environment).memory, "utf8")).toBe(
        "First note\n§\nSecond note",
      );
    } finally {
      child.stdin.end();
      await exited;
    }
    await mutateForTest({
      target: "memory",
      revision: file.revision,
      action: "add",
      content: "Now unlocked",
    });
  });

  it.skipIf(HostProcess.Platform.defaultValue() === "win32")(
    "refuses FIFOs, symlinks, and oversized stores without blocking or buffering them",
    async () => {
      await seed();
      const memory = resolveHermesMemoryPaths(environment).memory;
      const target = NodePath.join(home, "elsewhere.md");
      await NodeFSP.writeFile(target, "Linked note");
      await NodeFSP.rm(memory);
      expect(NodeChildProcess.spawnSync("mkfifo", [memory]).status).toBe(0);
      expect((await readHermesMemoryFiles(environment)).files[0]?.error).not.toBeNull();
      await NodeFSP.rm(memory);
      await NodeFSP.symlink(target, memory);
      expect((await readHermesMemoryFiles(environment)).files[0]?.error).not.toBeNull();
      await NodeFSP.rm(memory);
      await NodeFSP.writeFile(memory, Buffer.alloc(1_048_577, 0x61));
      expect((await readHermesMemoryFiles(environment)).files[0]?.error).not.toBeNull();
    },
  );

  it("refuses corrupt UTF-8, non-roundtripping files, and malformed config without writing", async () => {
    for (const raw of [Buffer.from([0xff, 0xfe, 0x01]), Buffer.from("one\n§\n\n§\ntwo")]) {
      await seed();
      await NodeFSP.writeFile(resolveHermesMemoryPaths(environment).memory, raw);
      const file = (await readHermesMemoryFiles(environment)).files[0]!;
      expect(file.error).not.toBeNull();
      await expect(
        mutateForTest({ target: "memory", revision: file.revision, action: "add", content: "no" }),
      ).rejects.toMatchObject({ reason: "unreadable" });
      expect(await NodeFSP.readFile(resolveHermesMemoryPaths(environment).memory)).toEqual(raw);
    }
    const file = await seed();
    await NodeFSP.writeFile(NodePath.join(home, "config.yaml"), "memory: [");
    await expect(
      mutateForTest({
        target: "memory",
        revision: file.revision,
        action: "remove",
        oldText: "First note",
      }),
    ).rejects.toThrow();
    expect(await NodeFSP.readFile(resolveHermesMemoryPaths(environment).memory, "utf8")).toBe(
      "First note\n§\nSecond note",
    );
  });
});
