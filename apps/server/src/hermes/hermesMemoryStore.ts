// @effect-diagnostics nodeBuiltinImport:off - Bounded descriptor reads and the Python writer child need direct Node APIs.
import * as NodeCrypto from "node:crypto";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodePath from "node:path";

import {
  HermesMemoryError,
  normalizeHermesMemoryEntry,
  type HermesMemoryFile,
  type HermesMemoryMutateInput,
  type HermesMemoryTarget,
} from "@t3tools/contracts";
import { parseDocument } from "yaml";

import { resolveHermesReasoningPaths } from "./hermesReasoning.ts";

const ENTRY_DELIMITER = "\n§\n";
const MAX_FILE_BYTES = 1_048_576;
const MISSING_REVISION = "missing";

export function serializeHermesMemory(entries: readonly string[]): string {
  return entries.join(ENTRY_DELIMITER);
}
export function memoryChars(entries: readonly string[]): number {
  return Array.from(serializeHermesMemory(entries)).length;
}

/** Hermes 0.21.0 MemoryStore._parse_entries / _detect_external_drift. Headers are
 * only for rendered system-prompt blocks; MEMORY.md and USER.md have no header. */
export function parseHermesMemory(
  raw: string,
  limit: number,
): { entries: string[]; error: string | null } {
  const normalized = raw.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const parsed = normalized.split(ENTRY_DELIMITER).map(normalizeHermesMemoryEntry).filter(Boolean);
  const clean = normalizeHermesMemoryEntry(normalized);
  const roundTrips = clean === serializeHermesMemory(parsed);
  const entryFits = parsed.every((entry) => Array.from(entry).length <= limit);
  return {
    entries: [...new Set(parsed)],
    error:
      !clean || (roundTrips && entryFits)
        ? null
        : "This file does not round-trip through Hermes's memory format. Fix its §-delimited entries in Hermes before editing here. Nothing has been changed.",
  };
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/** Reads through one descriptor into a bounded buffer, so a concurrent swap to a
 * FIFO, symlink, or oversized file can neither block nor buffer past the limit. */
async function readBytes(file: string): Promise<Buffer | null> {
  const { O_RDONLY, O_NOFOLLOW = 0, O_NONBLOCK = 0 } = NodeFS.constants;
  let handle: NodeFSP.FileHandle;
  try {
    handle = await NodeFSP.open(file, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) throw new Error("Not a regular bounded file");
    // One spare byte detects growth after fstat. Hermes replaces atomically, so
    // a descriptor's file only grows under a foreign in-place writer.
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length === buffer.length) throw new Error("File changed while reading");
    return buffer.subarray(0, length);
  } finally {
    await handle.close();
  }
}

function revision(bytes: Buffer | null): string {
  return bytes === null
    ? MISSING_REVISION
    : NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}
// Bind the editor to the selected store too: switching HERMES_HOME must not
// authorize an old draft merely because both homes contain identical notes.
function fileRevision(bytes: Buffer | null, filePath: string): string {
  return `${NodeCrypto.createHash("sha256").update(NodePath.resolve(filePath)).digest("hex")}:${revision(bytes)}`;
}
function decode(bytes: Buffer | null): string {
  return bytes === null
    ? ""
    : new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** get_builtin_memory_config reads the top-level memory mapping, not Hindsight. */
export function parseHermesMemoryLimits(raw: string): Record<HermesMemoryTarget, number> {
  const document = parseDocument(raw, { version: "1.1", merge: true });
  if (document.errors.length > 0) throw new Error("Invalid config.yaml");
  const config: unknown = document.toJS();
  if (config !== null && !isRecord(config)) throw new Error("Invalid config.yaml");
  const memory = isRecord(config) && isRecord(config.memory) ? config.memory : {};
  const limit = (key: string, fallback: number) => {
    const value = Object.hasOwn(memory, key) ? memory[key] : fallback;
    // MemoryStore receives int(value) from Hermes. Keep numeric-string configs compatible.
    const number =
      typeof value === "boolean"
        ? Number(value)
        : typeof value === "number"
          ? Math.trunc(value)
          : typeof value === "string" && /^[+-]?\d+$/.test(value.trim())
            ? Number(value)
            : NaN;
    if (!Number.isSafeInteger(number) || number < 0)
      throw new Error("Invalid memory character limit");
    return number;
  };
  return { memory: limit("memory_char_limit", 2200), user: limit("user_char_limit", 1375) };
}

export function resolveHermesMemoryPaths(environment: NodeJS.ProcessEnv) {
  // Path.home() in the child honors an instance HOME override on Unix. Never
  // fall back to the server user's store when that instance uses another home.
  const homedir =
    HostProcess.Platform.defaultValue() === "win32"
      ? NodeOS.homedir()
      : environment["HOME"] || NodeOS.homedir();
  const { home, configFile } = resolveHermesReasoningPaths(environment, homedir);
  const directory = NodePath.join(home, "memories");
  return {
    home,
    configFile,
    directory,
    memory: NodePath.join(directory, "MEMORY.md"),
    user: NodePath.join(directory, "USER.md"),
  };
}

export async function readHermesMemoryFiles(environment: NodeJS.ProcessEnv) {
  const paths = resolveHermesMemoryPaths(environment);
  const configBytes = await readBytes(paths.configFile);
  const limits = parseHermesMemoryLimits(decode(configBytes));
  const files = await Promise.all(
    (["memory", "user"] as const).map(async (target): Promise<HermesMemoryFile> => {
      try {
        const bytes = await readBytes(paths[target]);
        const parsed = parseHermesMemory(decode(bytes), limits[target]);
        return {
          target,
          ...parsed,
          charsUsed: memoryChars(parsed.entries),
          charLimit: limits[target],
          revision: fileRevision(bytes, paths[target]),
        };
      } catch {
        return {
          target,
          entries: [],
          charsUsed: 0,
          charLimit: limits[target],
          revision: "",
          error:
            "This memory file could not be read safely. Check its permissions and UTF-8 encoding; it has not been changed.",
        };
      }
    }),
  );
  return { files, configRevision: revision(configBytes), paths };
}

export function applyHermesMemoryMutation(
  file: HermesMemoryFile,
  input: HermesMemoryMutateInput,
): string[] {
  if (file.error !== null)
    throw new HermesMemoryError({ reason: "unreadable", detail: file.error });
  if (file.revision !== input.revision)
    throw new HermesMemoryError({
      reason: "conflict",
      detail: "Hermes memory changed. Review the latest entries and try again.",
    });
  const entries = [...file.entries];
  const content = input.action === "remove" ? null : normalizeHermesMemoryEntry(input.content);
  if (
    content !== null &&
    (!content ||
      content.includes(ENTRY_DELIMITER) ||
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(content))
  ) {
    throw new HermesMemoryError({
      reason: "invalidContent",
      detail: "Enter one non-empty UTF-8 entry without a § delimiter line.",
    });
  }
  if (input.action === "add") {
    if (content !== null) {
      if (entries.includes(content)) return entries;
      entries.push(content);
    }
  } else {
    // UI edits one exact entry, never Hermes's ambiguous substring-match shortcut.
    const index = entries.indexOf(input.oldText);
    if (index === -1)
      throw new HermesMemoryError({
        reason: "conflict",
        detail: "That entry no longer exists. Review the latest entries and try again.",
      });
    // Replacing with another existing entry collapses to it, as Hermes's reader would.
    const duplicate =
      content !== null && entries.some((entry, i) => i !== index && entry === content);
    entries.splice(index, 1, ...(content === null || duplicate ? [] : [content]));
  }
  if (input.action !== "remove" && memoryChars(entries) > file.charLimit) {
    throw new HermesMemoryError({
      reason: "capacity",
      detail: `This would use ${memoryChars(entries)} of ${file.charLimit} characters. Shorten the entry or remove a stale note first.`,
    });
  }
  const serialized = serializeHermesMemory(entries);
  if (Buffer.byteLength(serialized, "utf8") > MAX_FILE_BYTES) {
    throw new HermesMemoryError({
      reason: "capacity",
      detail:
        "This file would exceed T3 Code's 1 MiB memory-file safety limit. Shorten the entry before saving.",
    });
  }
  const reparsed = parseHermesMemory(serialized, file.charLimit).entries;
  const expected = [...new Set(entries)];
  if (
    reparsed.length !== expected.length ||
    reparsed.some((entry, index) => entry !== expected[index])
  ) {
    throw new HermesMemoryError({
      reason: "invalidContent",
      detail:
        "This entry would change Hermes's §-delimited entry boundaries. Remove the delimiter line before saving.",
    });
  }
  return entries;
}

/** Node has no portable flock API. A tiny stdlib-only Python process uses exactly
 * Hermes's flock / msvcrt protocol, rechecks both file and config revisions under
 * the lock, then fsyncs and replaces a sibling temp file. Never import Hermes:
 * importing its tools can initialize or mutate the user's live installation. */
const HERMES_MEMORY_WRITE_SCRIPT = String.raw`
import hashlib, json, os, pathlib, stat, sys, tempfile
request = json.loads(sys.stdin.buffer.read().decode('utf-8'))
p = pathlib.Path(request['path'])
p.parent.mkdir(parents=True, exist_ok=True)
def revision(p):
    try:
        fd = os.open(str(p), os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_NONBLOCK', 0) | getattr(os, 'O_BINARY', 0))
    except FileNotFoundError:
        return 'missing'
    with os.fdopen(fd, 'rb') as f:
        if not stat.S_ISREG(os.fstat(f.fileno()).st_mode):
            raise ValueError('Not a regular file')
        data = f.read(${MAX_FILE_BYTES} + 1)
    if len(data) > ${MAX_FILE_BYTES}:
        raise ValueError('File is too large')
    return hashlib.sha256(data).hexdigest()
with open(str(p) + '.lock', 'a+', encoding='utf-8') as lock:
    try:
        if os.name == 'nt':
            import msvcrt
            lock.seek(0)
            msvcrt.locking(lock.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print('busy')
        sys.exit(0)
    if revision(p) != request['revision'] or revision(pathlib.Path(request['configPath'])) != request['configRevision']:
        print('conflict')
        sys.exit(0)
    fd, temporary = tempfile.mkstemp(prefix='.mem_', dir=p.parent)
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='') as output:
            output.write(request['content'])
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, p)
        if os.name != 'nt':
            directory = os.open(str(p.parent), os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
print('ok')
`;

function runWriter(
  binary: string,
  request: string,
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(binary, ["-c", HERMES_MEMORY_WRITE_SCRIPT], {
      env: environment,
      stdio: ["pipe", "pipe", "ignore"],
      signal,
      timeout: 5000,
      windowsHide: true,
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(output.trim()) : reject(new Error("Memory writer failed")),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(request);
  });
}

export async function mutateHermesMemory(
  environment: NodeJS.ProcessEnv,
  binaryPath: string,
  input: HermesMemoryMutateInput,
  platform: NodeJS.Platform,
  signal?: AbortSignal,
): Promise<void> {
  const state = await readHermesMemoryFiles(environment);
  const file = state.files.find((file) => file.target === input.target);
  if (file === undefined)
    throw new HermesMemoryError({ reason: "unreadable", detail: "Memory file is unavailable." });
  const entries = applyHermesMemoryMutation(file, input);
  const request = JSON.stringify({
    path: state.paths[input.target],
    revision: file.revision.slice(file.revision.indexOf(":") + 1),
    configPath: state.paths.configFile,
    configRevision: state.configRevision,
    content: serializeHermesMemory(entries),
  });
  // A normal Hermes entry point lives alongside its Python interpreter. Otherwise
  // use the environment's Python; no dependency on Hermes's optional ACP package.
  const candidates = [
    ...new Set([
      ...(NodePath.isAbsolute(binaryPath)
        ? [
            NodePath.join(
              NodePath.dirname(binaryPath),
              platform === "win32" ? "python.exe" : "python3",
            ),
          ]
        : []),
      platform === "win32" ? "python" : "python3",
    ]),
  ];
  for (const [index, binary] of candidates.entries()) {
    let result: string;
    try {
      result = await runWriter(binary, request, environment, signal);
    } catch (error) {
      if (isMissing(error) && index < candidates.length - 1) continue;
      throw new HermesMemoryError({
        reason: "writeFailed",
        detail:
          "Could not save Hermes memory. A Python 3 interpreter and write access to the memory directory are required.",
        cause: error,
      });
    }
    if (result === "ok") return;
    if (result === "conflict" || result === "busy")
      throw new HermesMemoryError({
        reason: "conflict",
        detail:
          result === "busy"
            ? "Hermes is writing this file. Wait for its write to finish, then try again."
            : "Hermes memory or its limits changed. Review the latest entries and try again.",
      });
    throw new HermesMemoryError({
      reason: "writeFailed",
      detail: "The Hermes memory write did not complete.",
    });
  }
}
