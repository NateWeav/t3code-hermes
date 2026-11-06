import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { frameField, lifecycleAgents } from "../claude_background_subagent_lifecycle/output.ts";
import { HERMES_MODEL_SELECTION } from "../shared.ts";

/** Each `tool_call` the gateway reported, with its raw input. */
function toolCalls(transcript: ProviderReplayTranscript) {
  return transcript.entries.flatMap((entry) => {
    const update = frameField(
      frameField(entry.type === "emit_inbound" ? entry.frame : undefined, "params"),
      "update",
    );
    return frameField(update, "sessionUpdate") === "tool_call"
      ? [{ id: String(frameField(update, "toolCallId")), input: frameField(update, "rawInput") }]
      : [];
  });
}

/** The child lifecycle events reported on call `toolCallId`. */
function childEvents(transcript: ProviderReplayTranscript, toolCallId: string) {
  return transcript.entries.flatMap((entry) => {
    const update = frameField(
      frameField(entry.type === "emit_inbound" ? entry.frame : undefined, "params"),
      "update",
    );
    const child = frameField(frameField(update, "rawOutput"), "hermesDelegation");
    return frameField(update, "toolCallId") === toolCallId && child !== undefined
      ? [{ event: frameField(child, "event"), subagentId: frameField(child, "subagent_id") }]
      : [];
  });
}

/**
 * Hermes stops B as `interrupted`, runs only A on the model its task named, and reports A's
 * continued run on the `continue` call under the subagent_id its spawn reported.
 */
export function assertHermesBackgroundSubagentLifecycleDetails(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const { agentB } = lifecycleAgents(result, transcript.scenario);
  assert.equal(agentB?.status, "interrupted");
  assert.equal(`custom:cliproxyapi-claude:${agentB?.model}`, HERMES_MODEL_SELECTION.model);

  const calls = toolCalls(transcript);
  const continued = calls.find((call) => frameField(call.input, "action") === "continue");
  assert.isDefined(continued, "Agent A is continued with delegate_task's continue action");
  const subagentId = frameField(continued.input, "subagent_id");
  const spawn = calls.find((call) =>
    childEvents(transcript, call.id).some((child) => child.subagentId === subagentId),
  );
  assert.isDefined(spawn);
  assert.notEqual(spawn.id, continued.id);
  assert.deepEqual(childEvents(transcript, continued.id), [
    { event: "subagent.spawn_requested", subagentId },
    { event: "subagent.start", subagentId },
    { event: "subagent.complete", subagentId },
  ]);
}
