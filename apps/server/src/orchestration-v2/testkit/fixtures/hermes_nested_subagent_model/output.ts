import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { frameField } from "../claude_background_subagent_lifecycle/output.ts";
import { nestedSubagents } from "../claude_nested_subagent_model/output.ts";
import { HERMES_MODEL_SELECTION } from "../shared.ts";
import { HERMES_NESTED_SUBAGENT_MODEL } from "./input.ts";

/** Each tool call update the gateway reported, with its call id, raw input and child frame. */
function toolUpdates(transcript: ProviderReplayTranscript) {
  return transcript.entries.flatMap((entry) => {
    const update = frameField(
      frameField(entry.type === "emit_inbound" ? entry.frame : undefined, "params"),
      "update",
    );
    const kind = frameField(update, "sessionUpdate");
    return kind === "tool_call" || kind === "tool_call_update"
      ? [
          {
            kind,
            id: String(frameField(update, "toolCallId")),
            input: frameField(update, "rawInput"),
            child: frameField(frameField(update, "rawOutput"), "hermesDelegation"),
          },
        ]
      : [];
  });
}

/**
 * The root's one delegate_task call names the outer task's model. The nested child's frames reach
 * that call with its owner's id, on its owner's model rather than the session's, and T3 files it in
 * its owner's thread.
 */
export function assertHermesNestedSubagentModelDetails(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const { outer, nested } = nestedSubagents(result, transcript.scenario);
  assert.equal(nested.threadId, outer.childThreadId);

  const updates = toolUpdates(transcript);
  const calls = updates.filter((update) => update.kind === "tool_call");
  assert.lengthOf(calls, 1, "the root makes one delegate_task call; nested ones report on it");
  const [call] = calls;
  assert.isDefined(call);
  const tasks = frameField(call.input, "tasks");
  assert.deepInclude(Array.isArray(tasks) ? tasks[0] : call.input, {
    model: HERMES_NESTED_SUBAGENT_MODEL,
  });

  const frames = updates.flatMap((update) =>
    update.id === call.id && update.child !== undefined ? [update.child] : [],
  );
  const outerId = frames.find((frame) => frameField(frame, "depth") === 0);
  const nestedFrames = frames.filter((frame) => frameField(frame, "depth") === 1);
  assert.isDefined(outerId);
  assert.isNotEmpty(nestedFrames);
  const nestedId = frameField(nestedFrames[0], "subagent_id");
  for (const frame of nestedFrames) {
    assert.equal(frameField(frame, "parent_id"), frameField(outerId, "subagent_id"));
    assert.equal(frameField(frame, "model"), HERMES_NESTED_SUBAGENT_MODEL);
  }
  assert.equal(nested.nativeTaskRef?.nativeId, `${call.id}:subagent:${String(nestedId)}`);
  assert.notEqual(`custom:cliproxyapi-claude:${nested.model}`, HERMES_MODEL_SELECTION.model);
}
