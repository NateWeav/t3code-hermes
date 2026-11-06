import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as EffectAcpErrors from "effect-acp/errors";

import {
  hermesApprovalOptions,
  readHermesCompressReply,
  hermesApprovalPosture,
  hermesFollowsApprovalPosture,
  applyHermesAcpModelSelection,
  buildHermesAcpSpawnInput,
  HERMES_BUILT_IN_SLASH_COMMANDS,
  makeHermesEditApprovalCards,
  resolveHermesAcpBaseModelId,
  normalizeHermesT3McpToolCall,
  normalizeHermesTerminalResult,
  normalizeHermesWebSearchQuery,
  preserveHermesAgentActivityTitle,
  resolveHermesSessionModeId,
} from "./HermesAcpSupport.ts";
import {
  extractMcpToolCallIdentity,
  parseSessionUpdateEvent,
} from "@t3tools/provider-acp/server/runtimeModel";

describe("resolveHermesAcpBaseModelId", () => {
  it("falls back to the placeholder model for empty ids", () => {
    expect(resolveHermesAcpBaseModelId(undefined)).toBe("hermes-4");
    expect(resolveHermesAcpBaseModelId("   ")).toBe("hermes-4");
  });

  it("passes provider-owned model ids through untouched", () => {
    expect(resolveHermesAcpBaseModelId("  openai/gpt-5  ")).toBe("openai/gpt-5");
    expect(resolveHermesAcpBaseModelId("NousResearch/Hermes-4-405B")).toBe(
      "NousResearch/Hermes-4-405B",
    );
  });
});

describe("buildHermesAcpSpawnInput", () => {
  it("launches the ACP stdio server and forwards the environment untouched", () => {
    const spawn = buildHermesAcpSpawnInput(
      { binaryPath: "/usr/local/bin/hermes" },
      "/tmp/project",
      {
        HERMES_HOME: "/home/dev/.hermes",
      },
    );

    expect(spawn).toEqual({
      command: "/usr/local/bin/hermes",
      args: ["acp"],
      cwd: "/tmp/project",
      env: { HERMES_HOME: "/home/dev/.hermes" },
    });
  });

  it("defaults to `hermes` on PATH and omits env when none is supplied", () => {
    expect(buildHermesAcpSpawnInput(null, "/tmp/project")).toEqual({
      command: "hermes",
      args: ["acp"],
      cwd: "/tmp/project",
    });
  });
});

describe("hermesApprovalPosture", () => {
  it("asks whenever T3's policy asks, as Claude's permission mode does", () => {
    const granular = { granular: { rules: true, sandbox_approval: true } };
    expect(hermesApprovalPosture({ runtimeMode: "full-access" })).toBe("dontAsk");
    expect(hermesApprovalPosture({ runtimeMode: "auto" })).toBe("dontAsk");
    expect(hermesApprovalPosture({ runtimeMode: "auto-accept-edits" })).toBe("acceptEdits");
    expect(hermesApprovalPosture({ runtimeMode: "approval-required" })).toBe("ask");
    expect(
      hermesApprovalPosture({ runtimeMode: "full-access", approvalPolicy: "on-request" }),
    ).toBe("ask");
    expect(hermesApprovalPosture({ runtimeMode: "full-access", approvalPolicy: granular })).toBe(
      "ask",
    );
    expect(
      hermesApprovalPosture({
        runtimeMode: "full-access",
        approvalPolicy: "never",
        sandboxPolicy: { type: "workspaceWrite" },
      }),
    ).toBe("dontAsk");
    expect(
      hermesApprovalPosture({
        runtimeMode: "full-access",
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly" },
      }),
    ).toBe("ask");
  });
});

describe("hermesFollowsApprovalPosture", () => {
  it("follows T3's policy only on a Hermes that shows an edit it runs unasked", () => {
    const initialize = (agentCapabilities: Record<string, unknown>) => ({
      protocolVersion: 1,
      agentCapabilities,
    });
    expect(hermesFollowsApprovalPosture(initialize({ _meta: { command_approval: true } }))).toBe(
      true,
    );
    expect(hermesFollowsApprovalPosture(initialize({ loadSession: true }))).toBe(false);
  });
});

describe("resolveHermesSessionModeId", () => {
  // Hermes's session/new reply carries both; `setMode` writes the option.
  const modeState = {
    currentModeId: "default",
    availableModes: [
      { id: "default", name: "Default" },
      { id: "accept_edits", name: "Accept Edits" },
      { id: "dont_ask", name: "Don't Ask" },
    ],
  };
  const editApprovalPolicy = (currentValue: string) => ({
    id: "edit_approval_policy",
    name: "Edits",
    category: "mode" as const,
    type: "select" as const,
    currentValue,
    options: [
      { value: "ask", name: "Default" },
      { value: "workspace_session", name: "Accept Edits" },
      { value: "session", name: "Don't Ask" },
    ],
  });

  it("writes the edit_approval_policy value, not the modes id", () => {
    const configOptions = [editApprovalPolicy("ask")];
    expect(resolveHermesSessionModeId({ posture: "dontAsk", configOptions, modeState })).toBe(
      "session",
    );
    expect(resolveHermesSessionModeId({ posture: "acceptEdits", configOptions, modeState })).toBe(
      "workspace_session",
    );
    expect(
      resolveHermesSessionModeId({ posture: "ask", configOptions, modeState }),
    ).toBeUndefined();
    expect(
      resolveHermesSessionModeId({
        posture: "ask",
        configOptions: [editApprovalPolicy("session")],
        modeState,
      }),
    ).toBe("ask");
  });

  it("falls back to the modes ids, and leaves a Hermes without either alone", () => {
    expect(resolveHermesSessionModeId({ posture: "dontAsk", configOptions: [], modeState })).toBe(
      "dont_ask",
    );
    expect(
      resolveHermesSessionModeId({ posture: "ask", configOptions: [], modeState }),
    ).toBeUndefined();
    expect(
      resolveHermesSessionModeId({ posture: "dontAsk", configOptions: [], modeState: undefined }),
    ).toBeUndefined();
  });
});

describe("applyHermesAcpModelSelection", () => {
  const makeRecordingRuntime = (failure?: EffectAcpErrors.AcpError) => {
    const modelCalls: Array<string> = [];
    const runtime = {
      setSessionModel: (modelId: string) =>
        Effect.gen(function* () {
          modelCalls.push(modelId);
          if (failure) return yield* failure;
          return {};
        }),
    };
    return { runtime, modelCalls };
  };

  it.effect("calls session/set_model when the requested model differs from current", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "hermes-4",
        requestedModelId: "openai/gpt-5",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["openai/gpt-5"]);
      expect(result).toBe("openai/gpt-5");
    }),
  );

  it.effect("keeps the profile's model when asked for the bare placeholder", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "cliproxyapi:claude-opus-5-5",
        requestedModelId: "hermes-4",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("cliproxyapi:claude-opus-5-5");
    }),
  );

  it.effect("keeps the running model when asked for it without its provider", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "custom:cliproxyapi:claude-opus-5-5",
        requestedModelId: "claude-opus-5-5",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual([]);
      expect(result).toBe("custom:cliproxyapi:claude-opus-5-5");
    }),
  );

  it.effect("switches when a provider-qualified request only shares the running model's tail", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      const result = yield* applyHermesAcpModelSelection({
        runtime,
        currentModelId: "custom:cliproxyapi:gpt-6-astra",
        requestedModelId: "cliproxyapi:gpt-6-astra",
        mapError: (cause) => cause.message,
      });
      expect(modelCalls).toEqual(["cliproxyapi:gpt-6-astra"]);
      expect(result).toBe("cliproxyapi:gpt-6-astra");
    }),
  );

  it.effect("skips set_model when requested matches current or is absent", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      expect(
        yield* applyHermesAcpModelSelection({
          runtime,
          currentModelId: "hermes-4",
          requestedModelId: "hermes-4",
          mapError: (cause) => cause.message,
        }),
      ).toBe("hermes-4");
      expect(
        yield* applyHermesAcpModelSelection({
          runtime,
          currentModelId: "hermes-4",
          requestedModelId: undefined,
          mapError: (cause) => cause.message,
        }),
      ).toBe("hermes-4");
      expect(modelCalls).toEqual([]);
    }),
  );

  it.effect("re-sends the current model when forceReapply asks for an agent rebuild", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      // Hermes rebuilds the session's agent from config.yaml on every
      // set_session_model, which is the only way a reasoning level reaches a
      // session that is already running.
      expect(
        yield* applyHermesAcpModelSelection({
          runtime,
          currentModelId: "openai/gpt-5",
          requestedModelId: "openai/gpt-5",
          forceReapply: true,
          mapError: (cause) => cause.message,
        }),
      ).toBe("openai/gpt-5");
      // No requested model still rebuilds, using whatever the session is on.
      expect(
        yield* applyHermesAcpModelSelection({
          runtime,
          currentModelId: "openai/gpt-5",
          requestedModelId: undefined,
          forceReapply: true,
          mapError: (cause) => cause.message,
        }),
      ).toBe("openai/gpt-5");
      expect(modelCalls).toEqual(["openai/gpt-5", "openai/gpt-5"]);
    }),
  );

  it.effect("has nothing to re-send when forceReapply hits a session with no model", () =>
    Effect.gen(function* () {
      const { runtime, modelCalls } = makeRecordingRuntime();
      expect(
        yield* applyHermesAcpModelSelection({
          runtime,
          currentModelId: undefined,
          requestedModelId: undefined,
          forceReapply: true,
          mapError: (cause) => cause.message,
        }),
      ).toBeUndefined();
      expect(modelCalls).toEqual([]);
    }),
  );

  it.effect("propagates session/set_model failures via mapError", () =>
    Effect.gen(function* () {
      const failure = EffectAcpErrors.AcpRequestError.invalidParams("unknown model id");
      const { runtime } = makeRecordingRuntime(failure);
      const error = yield* Effect.flip(
        applyHermesAcpModelSelection({
          runtime,
          currentModelId: "hermes-4",
          requestedModelId: "openai/gpt-5",
          mapError: (cause) => cause.message,
        }),
      );
      expect(error).toBe(failure.message);
    }),
  );
});

describe("HERMES_BUILT_IN_SLASH_COMMANDS", () => {
  it("mirrors the ACP adapter's advertised command names", () => {
    // Source of truth: `_ADVERTISED_COMMANDS` in hermes-agent's
    // `acp_adapter/server.py`. These are the adapter's commands, not the
    // interactive `hermes` TUI's.
    expect(HERMES_BUILT_IN_SLASH_COMMANDS.map((command) => command.name)).toEqual([
      "help",
      "model",
      "tools",
      "context",
      "reset",
      "compress",
      "steer",
      "queue",
      "version",
    ]);
  });

  it("gives every seeded command a description and only hints the ones that take input", () => {
    for (const command of HERMES_BUILT_IN_SLASH_COMMANDS) {
      expect(command.description).toBeTruthy();
    }
    expect(
      HERMES_BUILT_IN_SLASH_COMMANDS.filter((command) => command.input !== undefined).map(
        (command) => command.name,
      ),
    ).toEqual(["model", "steer", "queue"]);
  });
});

describe("normalizeHermesTerminalResult", () => {
  const completedTerminal = (text: string, status: "completed" | "failed" = "completed") => ({
    toolCallId: "tc-1",
    kind: "execute",
    status,
    command: "git status",
    detail: "git status",
    data: {
      toolCallId: "tc-1",
      kind: "execute",
      command: "git status",
      content: [{ type: "content" as const, content: { type: "text" as const, text } }],
    },
  });

  it("moves multi-line terminal output out of Hermes's markdown summary", () => {
    const normalized = normalizeHermesTerminalResult(
      completedTerminal(
        "terminal result\n- **output:** On branch main\n- clean tree\n\nnothing to commit\n- **exit_code:** 0",
      ),
    );
    expect(normalized.data.content).toBeUndefined();
    expect(normalized.data.rawOutput).toEqual({
      stdout: "On branch main\n- clean tree\n\nnothing to commit",
      exitCode: 0,
    });
    expect(normalized.command).toBe("git status");
  });

  it("keeps field-shaped lines that belong to the command's own output", () => {
    const normalized = normalizeHermesTerminalResult(
      completedTerminal(
        [
          "terminal result",
          "- **output:** # Report",
          "- **output:** quoted",
          "- **exit_code:** 1",
          "tail line",
          "- **exit_code:** 0",
          "- **cwd:** /repo",
        ].join("\n"),
      ),
    );
    expect(normalized.data.rawOutput).toEqual({
      stdout: "# Report\n- **output:** quoted\n- **exit_code:** 1\ntail line",
      exitCode: 0,
    });
  });

  it("keeps the exit code when a failing command printed nothing", () => {
    const normalized = normalizeHermesTerminalResult(
      completedTerminal("✅ terminal completed\n- **exit_code:** 1", "failed"),
    );
    expect(normalized.data.content).toBeUndefined();
    expect(normalized.data.rawOutput).toEqual({ exitCode: 1 });
  });

  it("drops a running call's echo of its command, which is not output", () => {
    const running = { ...completedTerminal("$ git status"), status: "inProgress" as const };
    const normalized = normalizeHermesTerminalResult(running);
    expect(normalized.data.content).toBeUndefined();
    expect(normalized.command).toBe("git status");
  });

  it("leaves failure text, in-flight calls, and other tools untouched", () => {
    const failure = completedTerminal("terminal failed: command timed out", "failed");
    expect(normalizeHermesTerminalResult(failure)).toBe(failure);

    const running = {
      ...completedTerminal("terminal result\n- **output:** x"),
      status: "inProgress" as const,
    };
    expect(normalizeHermesTerminalResult(running)).toBe(running);

    const edit = { ...completedTerminal("terminal result\n- **output:** x"), kind: "edit" };
    expect(normalizeHermesTerminalResult(edit)).toBe(edit);
  });
});

describe("normalizeHermesWebSearchQuery", () => {
  const search = (text: string, kind = "fetch") => ({
    toolCallId: "toolu_1",
    kind,
    status: "pending" as const,
    data: { content: [{ type: "content" as const, content: { type: "text" as const, text } }] },
  });

  it("reads the whole query from Hermes's start text", () => {
    expect(
      normalizeHermesWebSearchQuery(search("Searching the web for: FIFA World Cup ticket pricing"))
        .data.rawInput,
    ).toEqual({ query: "FIFA World Cup ticket pricing" });
  });

  it("leaves results, other fetches and tools that name their input alone", () => {
    for (const toolCall of [
      search("Web results: 5"),
      search("Searching the web for: x", "read"),
      { ...search("Searching the web for: x"), data: { rawInput: { query: "y" } } },
    ]) {
      expect(normalizeHermesWebSearchQuery(toolCall)).toBe(toolCall);
    }
  });
});

describe("makeHermesEditApprovalCards", () => {
  const diff = {
    type: "diff" as const,
    path: "/repo/notes.txt",
    oldText: null,
    newText: "approved text",
  };
  const approval = {
    sessionId: "sess-1",
    options: [{ kind: "allow_once" as const, name: "Allow once", optionId: "allow_once" }],
    toolCall: {
      toolCallId: "edit-approval-1",
      kind: "edit" as const,
      content: [diff],
      rawInput: { tool: "write_file", arguments: { path: "notes.txt", content: "approved text" } },
    },
  };
  const write = (toolCallId: string, status: "completed" | "failed", text: string) => ({
    toolCallId,
    kind: "edit",
    status,
    data: {
      locations: [{ path: "notes.txt" }],
      content: [{ type: "content" as const, content: { type: "text" as const, text } }],
    },
  });

  it("shows the approved diff on the write, once, and keeps a denied write's reason", () => {
    const cards = makeHermesEditApprovalCards();
    cards.onPermissionRequest(approval);
    const done = cards.normalizeToolCall(write("toolu_1", "completed", "✅ write_file completed"));
    expect(done.data.content).toEqual([diff]);
    expect(cards.normalizeToolCall(done).data.content).toEqual([diff]);

    const unasked = write("toolu_2", "completed", "✅ write_file completed");
    expect(cards.normalizeToolCall(unasked)).toBe(unasked);

    cards.onPermissionRequest(approval);
    const denied = write("toolu_3", "failed", "Edit approval denied by ACP client");
    expect(cards.normalizeToolCall(denied)).toBe(denied);
    expect(cards.normalizeToolCall(unasked)).toBe(unasked);
  });

  it("keeps the diff an unasked write showed when it started, after an approved one", () => {
    const cards = makeHermesEditApprovalCards();
    const startedDiff = { ...diff, newText: "started text" };
    const started = (toolCallId: string) => ({
      toolCallId,
      kind: "edit",
      status: "pending" as const,
      data: { locations: [{ path: "notes.txt" }], content: [startedDiff] },
    });
    const unasked = started("toolu_4");
    expect(cards.normalizeToolCall(unasked)).toBe(unasked);
    expect(
      cards.normalizeToolCall(write("toolu_4", "completed", "✅ write_file completed")).data
        .content,
    ).toEqual([startedDiff]);

    cards.normalizeToolCall(started("toolu_5"));
    cards.onPermissionRequest(approval);
    expect(
      cards.normalizeToolCall(write("toolu_5", "completed", "✅ write_file completed")).data
        .content,
    ).toEqual([diff]);
  });

  it("drops only the status update that closes a permission card", () => {
    const { ignoreSessionUpdate } = makeHermesEditApprovalCards();
    const update = (toolCallId: string) => ({
      sessionId: "sess-1",
      update: {
        sessionUpdate: "tool_call_update" as const,
        toolCallId,
        status: "completed" as const,
      },
    });
    expect(ignoreSessionUpdate(update("edit-approval-1"))).toBe(true);
    expect(ignoreSessionUpdate(update("perm-check-12"))).toBe(true);
    expect(ignoreSessionUpdate(update("toolu_1"))).toBe(false);
  });
});

describe("preserveHermesAgentActivityTitle", () => {
  const parsed = (title: string, kind: "read" | "edit" | "other") => {
    const event = parseSessionUpdateEvent({
      sessionId: "s",
      update: { sessionUpdate: "tool_call", toolCallId: "tc-1", title, kind, status: "pending" },
    }).events[0];
    if (event?._tag !== "ToolCallUpdated") throw new Error("expected a tool call");
    return event.toolCall;
  };

  it("keeps the skill or memory name the shared summary would flatten", () => {
    for (const [title, kind] of [
      ["skill view (pr-review)", "read"],
      ["skill patch: pr-review", "edit"],
      ["memory add: user", "edit"],
    ] as const) {
      const toolCall = parsed(title, kind);
      expect(preserveHermesAgentActivityTitle(toolCall).title).toBe(title);
    }
  });

  it("leaves other tools on their shared summary", () => {
    const toolCall = parsed("read_file: src/app.ts", "read");
    expect(preserveHermesAgentActivityTitle(toolCall)).toBe(toolCall);
  });
});

describe("readHermesCompressReply", () => {
  it("counts only a compression that removed messages, with its token estimate", () => {
    expect(
      [
        "Compressed: 31 → 6 messages\nApprox request size: ~24,310 → ~3,904 tokens",
        "Compressed with fallback: 31 → 9 messages\nApprox request size: ~24,310 → ~6,120 tokens\nSummary generation failed; Hermes used limited fallback context and removed 22 message(s).",
        "Context compressed.",
        "No changes from compression: 2 messages\nApprox request size: ~11,452 tokens (unchanged)\n",
        "Compression refused (summary would grow the conversation): 8 messages preserved",
        "Compression aborted: 8 messages preserved\nSummary generation failed; no messages were removed.",
      ].map(readHermesCompressReply),
    ).toEqual([
      { compacted: true, beforeTokenCount: 24310, afterTokenCount: 3904 },
      { compacted: true, beforeTokenCount: 24310, afterTokenCount: 6120 },
      { compacted: true },
      { compacted: false },
      { compacted: false },
      { compacted: false },
    ]);
  });
});

describe("hermesApprovalOptions", () => {
  const request = (kinds: ReadonlyArray<[string, string]>) =>
    ({
      sessionId: "s",
      toolCall: { toolCallId: "perm-check-1" },
      options: kinds.map(([optionId, kind]) => ({ optionId, kind, name: optionId })),
    }) as unknown as Parameters<typeof hermesApprovalOptions>[0];

  it("offers no session scope when Hermes only allows once", () => {
    expect(
      hermesApprovalOptions(
        request([
          ["allow_once", "allow_once"],
          ["deny", "reject_once"],
        ]),
      ).map((option) => option.decision),
    ).toEqual(["cancel", "decline", "accept"]);
  });

  it("offers the session scope when Hermes does", () => {
    expect(
      hermesApprovalOptions(
        request([
          ["allow_once", "allow_once"],
          ["allow_session", "allow_always"],
          ["allow_always", "allow_always"],
          ["deny", "reject_once"],
        ]),
      ).map((option) => option.decision),
    ).toEqual(["cancel", "decline", "acceptForSession", "accept"]);
  });

  it("never offers a permanent grant as the session scope", () => {
    expect(
      hermesApprovalOptions(
        request([
          ["allow_once", "allow_once"],
          ["allow_always", "allow_always"],
          ["deny", "reject_once"],
        ]),
      ).map((option) => option.decision),
    ).toEqual(["cancel", "decline", "accept"]);
  });
});

describe("normalizeHermesT3McpToolCall", () => {
  // Hermes's gateway starts a tool call with no status and a `<name>: <preview>` title.
  const started = (title: string) => {
    const event = parseSessionUpdateEvent({
      sessionId: "s",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tc-1",
        title,
        kind: "other",
        rawInput: { threadId: "thread-1" },
      },
    }).events[0];
    if (event?._tag !== "ToolCallUpdated") throw new Error("expected a tool call");
    return normalizeHermesT3McpToolCall(event.toolCall);
  };

  it("recognizes T3 tools under the gateway's per-session server names", () => {
    for (const title of [
      "mcp__editor_t3_code_1a2b3c4d__t3_thread_wait: thread-1",
      "mcp__editor_0123456789abcdef0123_0__t3_thread_wait",
    ]) {
      const toolCall = started(title);
      expect(extractMcpToolCallIdentity(toolCall)).toMatchObject({
        server: "t3-code",
        tool: "t3_thread_wait",
      });
      expect(toolCall.status).toBe("inProgress");
    }
  });

  it("leaves other editor servers and Hermes tools alone", () => {
    const github = started("mcp__editor_github_1a2b3c4d__list_issues");
    expect(extractMcpToolCallIdentity(github)).toMatchObject({ server: "editor_github_1a2b3c4d" });
    expect(github.status).toBe("pending");
    expect(started("read_file: src/app.ts").status).toBe("pending");
  });
});
