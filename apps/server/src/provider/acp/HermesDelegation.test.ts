import { beforeEach, describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import type * as EffectAcpCompat from "effect-acp/compat";
import * as AcpSchema from "effect-acp/schema";

import {
  mergeToolCallState,
  parseSessionUpdateEvent,
  type AcpToolCallState,
} from "./AcpRuntimeModel.ts";
import { makeHermesSubagentExtractor } from "./HermesDelegation.ts";
import fixture from "./fixtures/hermes-delegation.json" with { type: "json" };
import olderFixture from "./fixtures/hermes-delegation-08b140d1.json" with { type: "json" };

const decodeNotification = Schema.decodeUnknownSync(AcpSchema.SessionNotification);
const batch = fixture.cases.find((item) => item.name === "batch")!;
const dispatched = fixture.cases.find((item) => item.name === "dispatched")!;

/** The merged tool state the adapter hands the extractor, as it does in a live turn. */
function tool(update: unknown, previous?: AcpToolCallState) {
  // Decoding pins the fixtures to Hermes's actual wire shape.
  const notification = decodeNotification({
    sessionId: "hermes-session",
    update,
  }) as EffectAcpCompat.SessionNotification;
  const event = parseSessionUpdateEvent(notification).events.find(
    (event) => event._tag === "ToolCallUpdated",
  );
  if (!event || event._tag !== "ToolCallUpdated")
    throw new Error("Fixture is not an ACP tool call");
  return mergeToolCallState(previous, event.toolCall);
}

function progress(start: AcpToolCallState | undefined, value: Record<string, unknown>) {
  return tool(
    {
      sessionUpdate: "tool_call_update",
      toolCallId: start?.toolCallId ?? "tc-fixture-dispatched",
      status: "in_progress",
      rawOutput: { hermesDelegation: value },
    },
    start,
  );
}

let extract = makeHermesSubagentExtractor();
beforeEach(() => {
  extract = makeHermesSubagentExtractor();
});
const updates = (toolCall: AcpToolCallState) => extract(toolCall)!;
/** A launch the adapter has already seen start. */
const launch = (update: unknown) => {
  const start = tool(update);
  extract(start);
  return start;
};

describe("Hermes delegate_task ACP boundary", () => {
  it("pins actual stock formatter output, not an invented raw JSON result", () => {
    expect(fixture.hermesCommit).toBe("ac0cfa7db94cefa90cf3e35191f38b53888b9e17");
    expect(olderFixture.hermesCommit).toBe("08b140d14e6c1d49f9b7ad02c9437fe940d54d65");
    for (const scenario of [...fixture.cases, ...olderFixture.cases]) {
      expect(scenario.start).not.toHaveProperty("rawInput");
      expect(scenario.complete).not.toHaveProperty("rawOutput");
      expect(scenario.start.kind).toBe("execute");
    }
  });

  // Hermes renamed stock titles ("delegate: goal" became "delegate_task: goal").
  it.each([fixture, olderFixture])(
    "recognizes stock delegations from Hermes $hermesCommit",
    (pinned) => {
      for (const scenario of pinned.cases) {
        expect(
          makeHermesSubagentExtractor()(tool(scenario.start))!.map((update) => update.title),
        ).toEqual(
          scenario.name === "batch"
            ? ["Inspect routing", "Run tests"]
            : [scenario.name === "dispatched" ? "Review parser" : "Review the parser"],
        );
      }
    },
  );

  it("starts one running subagent per batch child, keyed by call and index", () => {
    expect(updates(tool(batch.start))).toEqual([
      {
        nativeTaskId: "tc-fixture-batch:task:0",
        prompt: "Inspect routing",
        title: "Inspect routing",
        model: null,
        status: "running",
        childSessionId: null,
        result: null,
      },
      {
        nativeTaskId: "tc-fixture-batch:task:1",
        prompt: "Run tests",
        title: "Run tests",
        model: null,
        status: "running",
        childSessionId: null,
        result: null,
      },
    ]);
  });

  it.each(fixture.cases.filter((item) => item.name !== "dispatched"))(
    "parses stock $name completion status and result",
    (scenario) => {
      const start = launch(scenario.start);
      const completed = updates(tool(scenario.complete, start));
      if (scenario.name === "single") {
        expect(completed).toMatchObject([
          { status: "completed", model: "test/reviewer", result: "Parser reviewed." },
        ]);
      } else if (scenario.name === "batch") {
        expect(completed).toMatchObject([
          { status: "completed", result: "Routing inspected." },
          { status: "failed", model: "test/tester", result: "Test process failed." },
        ]);
      } else {
        expect(completed).toMatchObject([{ status: "failed", result: "Delegation unavailable." }]);
      }
    },
  );

  it("prefers structured args/results over clipped display content", () => {
    const start = tool({ ...batch.start, rawInput: batch.args });
    expect(updates(start)[0]).toMatchObject({ model: "test/researcher" });
    const completed = updates(
      tool({ ...batch.complete, content: [], rawOutput: batch.result }, start),
    );
    expect(completed.map((update) => update.status)).toEqual(["completed", "failed"]);
  });

  it("moves only the child a progress event names", () => {
    const start = tool({ ...batch.start, rawInput: batch.args });
    expect(
      updates(progress(start, { event: "subagent.text", task_index: 1, text: "Hi" })),
    ).toMatchObject([{ nativeTaskId: "tc-fixture-batch:task:1", status: "running" }]);
    expect(
      updates(progress(start, { event: "subagent.spawn_requested", task_index: 0 })),
    ).toMatchObject([{ nativeTaskId: "tc-fixture-batch:task:0", status: "pending" }]);
    expect(
      updates(
        progress(start, {
          event: "subagent.complete",
          task_index: 0,
          status: "completed",
          summary: "Done",
        }),
      ),
    ).toMatchObject([{ status: "completed", result: "Done", title: "Inspect routing" }]);
  });

  it("claims spinner frames and grandchildren without moving any child", () => {
    const start = tool({ ...batch.start, rawInput: batch.args });
    for (const text of ["(¬‿¬) analyzing...", "(¬‿¬) analyzing...ಠ_ಠ deliberating..."]) {
      expect(updates(progress(start, { event: "subagent.thinking", task_index: 0, text }))).toEqual(
        [],
      );
    }
    expect(updates(progress(start, { event: "subagent.start", task_index: 0, depth: 1 }))).toEqual(
      [],
    );
  });

  it("names no goal for a child it never saw start, so it cannot open a row", () => {
    const start = tool({ ...batch.start, rawInput: batch.args });
    expect(
      updates(progress(start, { event: "subagent.text", task_index: 99, text: "Unknown child" })),
    ).toMatchObject([{ prompt: "", title: null }]);
  });

  it("does not confuse stock background dispatch with successful completion", () => {
    const start = launch(dispatched.start);
    expect(updates(tool(dispatched.complete, start))).toMatchObject([
      {
        status: "idle",
        result: "Dispatched in background; stock Hermes ACP does not report child completion.",
      },
    ]);
  });

  it("keeps patched background children running until they report", () => {
    const start = launch({ ...dispatched.start, rawInput: dispatched.args });
    expect(
      updates(tool({ ...dispatched.complete, rawOutput: dispatched.result }, start)),
    ).toMatchObject([{ status: "running", result: null }]);
    // After the turn settles the adapter sees the raw update without the start,
    // and a restarted server has not seen the launch at all.
    expect(
      makeHermesSubagentExtractor()(
        progress(undefined, {
          event: "subagent.complete",
          task_index: 0,
          status: "completed",
          summary: "Background done.",
        }),
      )!,
    ).toMatchObject([
      {
        nativeTaskId: "tc-fixture-dispatched:task:0",
        status: "completed",
        result: "Background done.",
      },
    ]);
  });

  it("recognizes a stock background dispatch even when its goals were clipped", () => {
    const start = launch(dispatched.start);
    const clipped = tool(
      {
        ...dispatched.complete,
        content: [
          {
            type: "content",
            content: {
              type: "text",
              text: '{"status": "dispatched", "mode": "background", "goals": ["clipped...',
            },
          },
        ],
      },
      start,
    );
    expect(updates(clipped)).toMatchObject([{ status: "idle" }]);
  });

  it("keeps delegate controls and unrelated commands out of the roster", () => {
    for (const action of ["list", "steer", "stop"]) {
      expect(
        makeHermesSubagentExtractor()(
          tool({ ...batch.start, title: "delegate task", rawInput: { action } }),
        ),
      ).toBeUndefined();
    }
    expect(
      makeHermesSubagentExtractor()(tool({ ...batch.start, title: "delegate task", content: [] })),
    ).toBeUndefined();
    // Stock controls share the delegate_task title prefix; only spawns name a goal.
    for (const title of ["delegate_task: list", "delegate_task: stop sa-0-test1234"]) {
      const content = [{ type: "content", content: { type: "text", text: "Delegating task" } }];
      expect(
        makeHermesSubagentExtractor()(tool({ ...batch.start, title, content })),
      ).toBeUndefined();
    }
    expect(
      makeHermesSubagentExtractor()(tool({ ...batch.start, title: "terminal: echo hello" })),
    ).toBeUndefined();
  });

  it("bounds a stock batch count before allocating children", () => {
    const content = [
      { type: "content", content: { type: "text", text: "Delegating 4294967296 tasks\n\n1. A" } },
    ];
    expect(updates(tool({ ...batch.start, content }))).toHaveLength(128);
  });

  it("settles missing/truncated stock child results without inventing success", () => {
    const start = launch(batch.start);
    expect(updates(tool({ ...batch.complete, content: [] }, start))).toMatchObject([
      { status: "interrupted", result: "Hermes returned without a result for this task." },
      { status: "interrupted", result: "Hermes returned without a result for this task." },
    ]);
  });

  it("accepts Hermes JSON-string task arrays", () => {
    const start = tool({
      ...batch.start,
      title: "delegate task",
      content: [],
      rawInput: { tasks: JSON.stringify(batch.args.tasks) },
    });
    expect(updates(start).map((update) => update.title)).toEqual(["Inspect routing", "Run tests"]);
  });

  it("maps registry-stalled results to failure", () => {
    const start = tool({ ...dispatched.start, rawInput: dispatched.args });
    expect(
      updates(
        progress(start, {
          event: "subagent.complete",
          task_index: 0,
          status: "stalled",
          error: "No heartbeat",
        }),
      ),
    ).toMatchObject([{ status: "failed", result: "No heartbeat" }]);
  });
});
