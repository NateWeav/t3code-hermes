import { describe, expect, it } from "vite-plus/test";

import {
  describeHindsightAgentMemory,
  describeHindsightKeyWait,
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
    hasSavedKey: false,
    serverUrl: "https://hs.example",
    serverHasKey: true,
  };
  const bare = {
    enabled: true,
    hasServer: false,
    hasSavedKey: false,
    serverUrl: null,
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

  it("hands an open server, or a keyed one to a machine that has its key, in one click", () => {
    const open = planHindsightServerHandoff({ url: "", hasKey: false }, [
      { ...keyedSource, serverHasKey: false },
      bare,
    ]);
    expect(shouldHandOffHindsightServer(bare, open, { enabling: true, withKey: false })).toBe(true);
    const keyed = planHindsightServerHandoff({ url: "https://hs.example", hasKey: true }, []);
    expect(
      shouldHandOffHindsightServer({ ...bare, hasSavedKey: true }, keyed, {
        enabling: true,
        withKey: false,
      }),
    ).toBe(true);
    expect(describeHindsightKeyWait([{ ...bare, hasSavedKey: true }], keyed)).toBeNull();
  });
});
