import { describe, expect, it } from "vite-plus/test";

import {
  describeHindsightAgentMemory,
  describeHindsightKeyWait,
  hindsightSharedPatch,
  planHindsightServerHandoff,
  shouldHandOffHindsightServer,
  summarizeHindsightMachines,
} from "./hindsight.ts";

const base = { applying: false, blocker: null, agents: [], detail: null } as const;

describe("describeHindsightAgentMemory", () => {
  it("names the blocker before anything else, so the switch says what to fix", () => {
    expect(
      describeHindsightAgentMemory({ ...base, blocker: "notConfigured" }, { enabled: true }).label,
    ).toBe("No Hindsight server");
    expect(
      describeHindsightAgentMemory({ ...base, blocker: "nodeMissing" }, { enabled: true }).label,
    ).toBe("Node.js not found");
  });

  it("only reads as on when every agent is actually wired", () => {
    const wired = { target: "codex", state: "installed", detail: null } as const;
    // Fully wired needs no headline: the switch already says it is on.
    expect(
      describeHindsightAgentMemory({ ...base, agents: [wired] }, { enabled: true }),
    ).toMatchObject({ tone: "ready", label: null });
    const summary = describeHindsightAgentMemory(
      {
        ...base,
        agents: [wired, { target: "hermes", state: "failed", detail: "config.yaml did not parse" }],
      },
      { enabled: true },
    );
    expect(summary.tone).toBe("attention");
    expect(summary.agents[0]?.status).toBeNull();
    expect(summary.agents[1]).toMatchObject({ label: "Hermes", status: "Failed" });
  });

  it("spells out a wired agent's coverage gap, not just its name", () => {
    const summary = describeHindsightAgentMemory(
      {
        ...base,
        agents: [
          { target: "codex", state: "installed", detail: null },
          {
            target: "claudeCode",
            state: "installed",
            detail: "Not covered: work (own config home).",
          },
          { target: "hermes", state: "failed", detail: "config.yaml did not parse" },
        ],
      },
      { enabled: true },
    );
    expect(summary.agents.map((agent) => agent.text)).toEqual([
      "Codex",
      "Claude Code · Not covered: work (own config home).",
      "Hermes failed · config.yaml did not parse",
    ]);
  });

  it("keeps a failed cleanup in view after switching off", () => {
    const failed = describeHindsightAgentMemory(
      { ...base, agents: [{ target: "codex", state: "failed", detail: "npx exited 1" }] },
      { enabled: false },
    );
    expect(failed).toMatchObject({ tone: "attention", label: null });
    expect(failed.agents[0]?.text).toBe("Codex failed · npx exited 1");
    expect(
      describeHindsightAgentMemory(
        { ...base, agents: [{ target: "codex", state: "notInstalled", detail: null }] },
        { enabled: false },
      ).tone,
    ).toBe("idle");
  });

  it("reports an in-flight pass instead of a stale verdict", () => {
    expect(
      describeHindsightAgentMemory(
        { ...base, applying: true, blocker: "nodeMissing" },
        { enabled: true },
      ).label,
    ).toBe("Applying…");
  });
});

describe("summarizeHindsightMachines", () => {
  const wired = {
    ...base,
    agents: [{ target: "codex", state: "installed", detail: null }],
  } as const;

  it("reads as mixed until every writable machine is on, so one click finishes the job", () => {
    const summary = summarizeHindsightMachines([
      { enabled: true, writable: true, state: wired },
      { enabled: false, writable: true, state: base },
      { enabled: false, writable: false, state: base },
    ]);
    expect(summary).toMatchObject({ checked: false, mixed: true, label: "On for 1 of 2 machines" });
  });

  it("is plainly on with no headline once every writable machine is wired", () => {
    expect(
      summarizeHindsightMachines([
        { enabled: true, writable: true, state: wired },
        { enabled: false, writable: false, state: base },
      ]),
    ).toMatchObject({ checked: true, mixed: false, tone: "ready", label: null });
  });

  it("cannot be toggled with nothing writable", () => {
    expect(summarizeHindsightMachines([]).canToggle).toBe(false);
    expect(
      summarizeHindsightMachines([{ enabled: false, writable: false, state: null }]).canToggle,
    ).toBe(false);
  });
});

describe("handing a machine the shared server", () => {
  const keyedSource = {
    enabled: true,
    hasServer: true,
    serverUrl: "https://hs.example",
    savedUrl: "",
    serverHasKey: true,
  };
  const bare = {
    enabled: true,
    hasServer: false,
    serverUrl: null,
    savedUrl: "",
    serverHasKey: false,
  };

  it("never hands a keyed server on without a key, and says what is missing", () => {
    const handoff = planHindsightServerHandoff({ url: "", hasKey: false }, [keyedSource, bare]);
    expect(handoff).toEqual({ url: "https://hs.example", needsKey: true });
    expect(shouldHandOffHindsightServer(bare, handoff, { enabling: true, withKey: false })).toBe(
      false,
    );
    expect(describeHindsightKeyWait([keyedSource, bare], handoff)).toBe(
      "Enter the API key below to finish 1 machine",
    );
    // Saving the key finishes it.
    expect(shouldHandOffHindsightServer(bare, handoff, { enabling: false, withKey: true })).toBe(
      true,
    );
  });

  it("hands an open server on in one click", () => {
    const open = planHindsightServerHandoff({ url: "", hasKey: false }, [
      { ...keyedSource, serverHasKey: false },
      bare,
    ]);
    expect(shouldHandOffHindsightServer(bare, open, { enabling: true, withKey: false })).toBe(true);
    expect(describeHindsightKeyWait([bare], open)).toBeNull();
  });

  it("never pairs a keyed server with a key the machine saved for some other server", () => {
    const keyed = planHindsightServerHandoff({ url: "https://hs.example", hasKey: true }, []);
    // `bare` may well have an old key saved; only a key entered here goes with the URL.
    expect(shouldHandOffHindsightServer(bare, keyed, { enabling: true, withKey: false })).toBe(
      false,
    );
    expect(shouldHandOffHindsightServer(bare, keyed, { enabling: true, withKey: true })).toBe(true);
  });

  it("keeps every key with the server it was entered for", () => {
    const handoff = planHindsightServerHandoff({ url: "", hasKey: false }, [keyedSource, bare]);
    const elsewhere = { ...keyedSource, serverUrl: "http://own-host:8888" };
    const write = { kind: "apiKey", apiKey: "hsk_new" } as const;

    expect(hindsightSharedPatch(keyedSource, handoff, write)).toEqual({ apiKey: "hsk_new" });
    // Handed the server in the same write as its key.
    expect(hindsightSharedPatch(bare, handoff, write)).toEqual({
      baseUrl: "https://hs.example",
      apiKey: "hsk_new",
    });
    // On another server: its own key stays, and this one never goes there.
    expect(hindsightSharedPatch(elsewhere, handoff, write)).toBeNull();
  });

  it("drops a machine's key when it moves to another server", () => {
    const open = planHindsightServerHandoff({ url: "", hasKey: false }, [
      { ...keyedSource, serverHasKey: false },
    ]);
    expect(hindsightSharedPatch(bare, open, { kind: "switch", agentMemory: true })).toEqual({
      agentMemory: true,
      baseUrl: "https://hs.example",
      apiKey: "",
    });
    const onOverride = {
      ...keyedSource,
      savedUrl: "http://old:8888",
      serverUrl: "http://old:8888",
    };
    expect(
      hindsightSharedPatch(onOverride, open, { kind: "server", url: "http://new:8888" }),
    ).toEqual({ baseUrl: "http://new:8888", apiKey: "" });
    expect(hindsightSharedPatch(onOverride, open, { kind: "server", url: "" })).toEqual({
      baseUrl: "",
      apiKey: "",
    });
    expect(
      hindsightSharedPatch(onOverride, open, { kind: "server", url: "http://old:8888" }),
    ).toBeNull();
    // Already on it through Hermes, with Hermes' key: no override, so that key stays in use.
    const viaHermes = { ...keyedSource, serverUrl: "http://old:8888" };
    expect(
      hindsightSharedPatch(viaHermes, open, { kind: "server", url: "http://old:8888/" }),
    ).toBeNull();
  });

  it("treats spellings of one server as the same server", () => {
    const handoff = planHindsightServerHandoff({ url: "https://HS.example/", hasKey: true }, []);
    const reported = { ...keyedSource, serverUrl: "https://hs.example" };
    const savedWithCredentials = { ...bare, savedUrl: "https://user:pw@hs.example/" };
    const write = { kind: "apiKey", apiKey: "" } as const;

    expect(hindsightSharedPatch(reported, handoff, write)).toEqual({ apiKey: "" });
    expect(hindsightSharedPatch(savedWithCredentials, handoff, write)).toEqual({ apiKey: "" });
    // A different path is a different server.
    expect(
      hindsightSharedPatch(
        { ...keyedSource, serverUrl: "https://hs.example/other" },
        handoff,
        write,
      ),
    ).toBeNull();
  });
});
