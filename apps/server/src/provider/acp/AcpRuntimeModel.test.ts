import { describe, expect, it } from "vite-plus/test";

import type * as EffectAcpSchema from "effect-acp/schema";

import {
  extractModelConfigId,
  mergeToolCallState,
  parsePermissionRequest,
  parsePromptResponseUsage,
  parseSessionModeState,
  parseAcpAvailableCommands,
  parseSessionUpdateEvent,
  sessionUpdateIsReplay,
  syntheticLoadSessionResponseFromInitialize,
} from "./AcpRuntimeModel.ts";

describe("AcpRuntimeModel", () => {
  it("parses session mode state from typed ACP session setup responses", () => {
    const modeState = parseSessionModeState({
      sessionId: "session-1",
      modes: {
        currentModeId: " code ",
        availableModes: [
          { id: " ask ", name: " Ask ", description: " Request approval " },
          { id: " code ", name: " Code " },
        ],
      },
      configOptions: [],
    } satisfies EffectAcpSchema.NewSessionResponse);

    expect(modeState).toEqual({
      currentModeId: "code",
      availableModes: [
        { id: "ask", name: "Ask", description: "Request approval" },
        { id: "code", name: "Code" },
      ],
    });
  });

  it("extracts the model config id from typed ACP config options", () => {
    const modelConfigId = extractModelConfigId({
      sessionId: "session-1",
      configOptions: [
        {
          id: "approval",
          name: "Approval Mode",
          category: "permission",
          type: "select",
          currentValue: "ask",
          options: [{ value: "ask", name: "Ask" }],
        },
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "default",
          options: [{ value: "default", name: "Auto" }],
        },
      ],
    } satisfies EffectAcpSchema.NewSessionResponse);

    expect(modelConfigId).toBe("model");
  });

  it("detects Grok session replay updates from _meta.isReplay", () => {
    expect(
      sessionUpdateIsReplay({
        _meta: { isReplay: true },
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "replayed" },
        },
      } satisfies EffectAcpSchema.SessionNotification),
    ).toBe(true);
    expect(
      sessionUpdateIsReplay({
        sessionId: "session-1",
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "live" },
        },
      } satisfies EffectAcpSchema.SessionNotification),
    ).toBe(false);
  });

  it("builds a synthetic load response from initialize model state", () => {
    const response = syntheticLoadSessionResponseFromInitialize({
      protocolVersion: 1,
      _meta: {
        modelState: {
          currentModelId: "grok-build",
          availableModels: [{ modelId: "grok-build", name: "Grok Build" }],
        },
      },
    } satisfies EffectAcpSchema.InitializeResponse);

    expect(response.models?.currentModelId).toBe("grok-build");
    expect(response._meta).toMatchObject({ t3SessionLoadReady: "replay_idle" });
  });

  it("accepts initialize model descriptions with null", () => {
    const response = syntheticLoadSessionResponseFromInitialize({
      protocolVersion: 1,
      _meta: {
        modelState: {
          currentModelId: "grok-build",
          availableModels: [{ modelId: "grok-build", name: "Grok Build", description: null }],
        },
      },
    } satisfies EffectAcpSchema.InitializeResponse);

    expect(response.models?.availableModels[0]?.description).toBeNull();
  });

  it("ignores malformed initialize model state in synthetic load responses", () => {
    const response = syntheticLoadSessionResponseFromInitialize({
      protocolVersion: 1,
      _meta: {
        modelState: {
          currentModelId: "grok-build",
          availableModels: [null],
        },
        modeState: {
          currentModeId: "code",
          availableModes: [{ id: "code", name: 12 }],
        },
      },
    } as EffectAcpSchema.InitializeResponse);

    expect(response.models).toBeUndefined();
    expect(response.modes).toBeUndefined();
    expect(response._meta).toMatchObject({ t3SessionLoadReady: "replay_idle" });
  });

  it("builds a synthetic load response with initialize mode state", () => {
    const response = syntheticLoadSessionResponseFromInitialize({
      protocolVersion: 1,
      _meta: {
        modeState: {
          currentModeId: "code",
          availableModes: [
            { id: "ask", name: "Ask" },
            { id: "code", name: "Code" },
          ],
        },
      },
    } satisfies EffectAcpSchema.InitializeResponse);

    expect(response.modes?.currentModeId).toBe("code");
    expect(response.modes?.availableModes).toHaveLength(2);
  });

  it("projects typed ACP tool call updates into runtime events", () => {
    const created = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "Terminal",
        kind: "execute",
        status: "pending",
        rawInput: {
          executable: "bun",
          args: ["run", "typecheck"],
        },
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Running checks",
            },
          },
        ],
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(created.events).toEqual([
      {
        _tag: "ToolCallUpdated",
        toolCall: {
          toolCallId: "tool-1",
          kind: "execute",
          title: "Ran command",
          status: "pending",
          command: "bun run typecheck",
          detail: "bun run typecheck",
          data: {
            toolCallId: "tool-1",
            kind: "execute",
            command: "bun run typecheck",
            rawInput: {
              executable: "bun",
              args: ["run", "typecheck"],
            },
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: "Running checks",
                },
              },
            ],
          },
        },
        rawPayload: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "tool-1",
            title: "Terminal",
            kind: "execute",
            status: "pending",
            rawInput: {
              executable: "bun",
              args: ["run", "typecheck"],
            },
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: "Running checks",
                },
              },
            ],
          },
        },
      },
    ]);

    const updated = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: "tool-1",
        status: "completed",
        rawOutput: { exitCode: 0 },
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(updated.events).toHaveLength(1);
    expect(updated.events[0]?._tag).toBe("ToolCallUpdated");
    const createdEvent = created.events[0];
    const updatedEvent = updated.events[0];
    if (createdEvent?._tag === "ToolCallUpdated" && updatedEvent?._tag === "ToolCallUpdated") {
      expect(mergeToolCallState(createdEvent.toolCall, updatedEvent.toolCall)).toMatchObject({
        toolCallId: "tool-1",
        status: "completed",
        title: "Ran command",
        detail: "bun run typecheck",
        command: "bun run typecheck",
      });
    }
  });

  it("extracts Hermes terminal commands from ACP content when raw input is omitted", () => {
    const created = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "tool_call",
        toolCallId: "tool-1",
        title: "terminal: git status --short",
        kind: "execute",
        status: "pending",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "$ git status --short",
            },
          },
        ],
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(created.events[0]).toMatchObject({
      _tag: "ToolCallUpdated",
      toolCall: {
        toolCallId: "tool-1",
        kind: "execute",
        title: "Ran command",
        command: "git status --short",
        detail: "git status --short",
        data: {
          command: "git status --short",
        },
      },
    });
  });

  it("trims padded current mode updates before emitting a mode change", () => {
    const result = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "current_mode_update",
        currentModeId: " code ",
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(result.modeId).toBe("code");
    expect(result.events).toEqual([
      {
        _tag: "ModeChanged",
        modeId: "code",
      },
    ]);
  });

  it("projects typed ACP plan and content updates", () => {
    const planResult = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "plan",
        entries: [
          { content: " Inspect state ", priority: "high", status: "completed" },
          { content: "", priority: "medium", status: "in_progress" },
        ],
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(planResult.events).toEqual([
      {
        _tag: "PlanUpdated",
        payload: {
          plan: [
            { step: "Inspect state", status: "completed" },
            { step: "Step 2", status: "inProgress" },
          ],
        },
        rawPayload: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "plan",
            entries: [
              { content: " Inspect state ", priority: "high", status: "completed" },
              { content: "", priority: "medium", status: "in_progress" },
            ],
          },
        },
      },
    ]);

    const contentResult = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: "hello from acp",
        },
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(contentResult.events).toEqual([
      {
        _tag: "ContentDelta",
        text: "hello from acp",
        rawPayload: {
          sessionId: "session-1",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "hello from acp",
            },
          },
        },
      },
    ]);
  });

  it("keeps permission request parsing compatible with loose extension payloads", () => {
    const request = parsePermissionRequest({
      sessionId: "session-1",
      options: [
        {
          optionId: "allow-once",
          name: "Allow once",
          kind: "allow_once",
        },
      ],
      toolCall: {
        toolCallId: "tool-1",
        title: "`cat package.json`",
        kind: "execute",
        status: "pending",
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: "Not in allowlist",
            },
          },
        ],
      },
    });

    expect(request).toMatchObject({
      kind: "execute",
      detail: "cat package.json",
      toolCall: {
        toolCallId: "tool-1",
        kind: "execute",
        status: "pending",
        command: "cat package.json",
      },
    });
  });

  // Fixtures below mirror what NousResearch/hermes-agent's `acp_adapter`
  // actually puts on the wire (see its `_ADVERTISED_COMMANDS` table and
  // `_build_usage_update`), so a Hermes-side rename shows up as a test failure.
  describe("available_commands_update", () => {
    it("maps ACP command entries onto provider slash commands", () => {
      const parsed = parseSessionUpdateEvent({
        sessionId: "session-1",
        update: {
          sessionUpdate: "available_commands_update",
          availableCommands: [
            { name: "help", description: "List available commands" },
            {
              name: "model",
              description: "Show current model and provider, or switch models",
              input: { hint: "model name to switch to" },
            },
            { name: "compress", description: "Compress conversation context" },
          ],
        },
      } satisfies EffectAcpSchema.SessionNotification);

      expect(parsed.events).toEqual([
        {
          _tag: "CommandsUpdated",
          commands: [
            { name: "help", description: "List available commands" },
            {
              name: "model",
              description: "Show current model and provider, or switch models",
              input: { hint: "model name to switch to" },
            },
            { name: "compress", description: "Compress conversation context" },
          ],
          rawPayload: expect.anything(),
        },
      ]);
    });

    it("emits an empty list so a stale menu is cleared", () => {
      const parsed = parseSessionUpdateEvent({
        sessionId: "session-1",
        update: { sessionUpdate: "available_commands_update", availableCommands: [] },
      } satisfies EffectAcpSchema.SessionNotification);

      expect(parsed.events).toEqual([
        { _tag: "CommandsUpdated", commands: [], rawPayload: expect.anything() },
      ]);
    });

    it("strips a leading slash, drops nameless entries, and dedupes by name", () => {
      expect(
        parseAcpAvailableCommands([
          { name: "  /compress ", description: " Compress conversation context " },
          { name: "   ", description: "nameless" },
          { name: "COMPRESS", description: "duplicate", input: { hint: "backfilled" } },
        ]),
      ).toEqual([
        {
          name: "compress",
          description: "Compress conversation context",
          input: { hint: "backfilled" },
        },
      ]);
    });
  });

  describe("usage_update", () => {
    it("maps size/used onto the context window snapshot", () => {
      const parsed = parseSessionUpdateEvent({
        sessionId: "session-1",
        update: { sessionUpdate: "usage_update", size: 200_000, used: 48_120 },
      } satisfies EffectAcpSchema.SessionNotification);

      expect(parsed.events).toEqual([
        {
          _tag: "UsageUpdated",
          usage: { usedTokens: 48_120, maxTokens: 200_000 },
          rawPayload: expect.anything(),
        },
      ]);
    });

    it("omits maxTokens when the agent reports no usable context window", () => {
      const parsed = parseSessionUpdateEvent({
        sessionId: "session-1",
        update: { sessionUpdate: "usage_update", size: 0, used: 1_200 },
      } satisfies EffectAcpSchema.SessionNotification);

      expect(parsed.events).toEqual([
        { _tag: "UsageUpdated", usage: { usedTokens: 1_200 }, rawPayload: expect.anything() },
      ]);
    });
  });

  describe("prompt response usage", () => {
    it("maps the end-of-turn totals onto context-window snapshot field names", () => {
      // Shaped like Hermes's PromptResponse.usage.
      expect(
        parsePromptResponseUsage({
          stopReason: "end_turn",
          usage: {
            inputTokens: 48_120,
            outputTokens: 900,
            totalTokens: 51_000,
            cachedReadTokens: 12_000,
            thoughtTokens: 300,
          },
        } satisfies EffectAcpSchema.PromptResponse),
      ).toEqual({
        totalTokens: 51_000,
        inputTokens: 48_120,
        outputTokens: 900,
        cachedInputTokens: 12_000,
        reasoningOutputTokens: 300,
      });
    });

    it("derives the total from the breakdown when the agent leaves it at zero", () => {
      expect(
        parsePromptResponseUsage({
          stopReason: "end_turn",
          usage: { inputTokens: 1_200, outputTokens: 300, totalTokens: 0 },
        } satisfies EffectAcpSchema.PromptResponse),
      ).toEqual({ totalTokens: 1_500, inputTokens: 1_200, outputTokens: 300 });
    });

    it("returns nothing when the agent omits usage or reports an empty turn", () => {
      expect(
        parsePromptResponseUsage({
          stopReason: "end_turn",
        } satisfies EffectAcpSchema.PromptResponse),
      ).toBeUndefined();
      expect(
        parsePromptResponseUsage({
          stopReason: "end_turn",
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        } satisfies EffectAcpSchema.PromptResponse),
      ).toBeUndefined();
    });
  });

  it("surfaces session_info_update with its raw payload for vendor _meta", () => {
    const parsed = parseSessionUpdateEvent({
      sessionId: "session-1",
      update: {
        sessionUpdate: "session_info_update",
        title: "  Refactor the parser  ",
        updatedAt: "2026-08-16T00:00:00Z",
        _meta: { hermes: { sessionProvenance: { reason: "compression" } } },
      },
    } satisfies EffectAcpSchema.SessionNotification);

    expect(parsed.events).toEqual([
      {
        _tag: "SessionInfoUpdated",
        title: "Refactor the parser",
        rawPayload: expect.anything(),
      },
    ]);
  });
});
