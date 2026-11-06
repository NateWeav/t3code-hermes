import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import { backgroundNotifications, firstBackgroundRosterTask, projectionFor } from "../shared.ts";

const BACKGROUND_COMMAND = "sleep 8 && echo BG_DONE";

/** The `proc_…` ids Hermes's background `terminal` results gave the agent, in start order. */
function hermesBackgroundProcessIds(transcript: ProviderReplayTranscript): ReadonlyArray<string> {
  return transcript.entries.flatMap((entry) => {
    if (entry.type !== "emit_inbound") return [];
    const match = /- \*\*session_id:\*\* (proc_[0-9a-f]+)/.exec(JSON.stringify(entry.frame));
    return match === null ? [] : [match[1]!];
  });
}

/** The roster lists the command under the `proc_…` id Hermes's terminal gave the agent. */
export function assertHermesRosterListsBackgroundProcess(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const [backgroundTaskId] = hermesBackgroundProcessIds(transcript);
  assert.isDefined(backgroundTaskId, "Hermes must start the command as a background process");
  assert.equal(firstBackgroundRosterTask(result).task.taskId, backgroundTaskId);
}

/**
 * The roster carries the `proc_…` id and the command (Hermes's terminal takes no description).
 * Hermes's wake turn reaches ACP viewers without the completion notice it answers, so the wake's
 * outcome is unknown.
 */
export function assertHermesBackgroundTaskWakeDetails(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const [backgroundTaskId] = hermesBackgroundProcessIds(transcript);
  assert.isDefined(backgroundTaskId, "Hermes must start the command as a background process");
  assert.deepEqual(firstBackgroundRosterTask(result).task, {
    taskId: backgroundTaskId,
    description: BACKGROUND_COMMAND,
    kind: "command",
  });
  assert.deepEqual(backgroundNotifications(projectionFor(result, transcript.scenario)), [
    {
      summary: `Command "${BACKGROUND_COMMAND}" finished`,
      outcome: "unknown",
      source: { kind: "command" },
    },
  ]);
}
