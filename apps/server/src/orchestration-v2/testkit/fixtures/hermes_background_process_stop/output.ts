import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import {
  HERMES_BACKGROUND_PROCESS_STOP_COMMAND,
  HERMES_BACKGROUND_PROCESS_STOP_PROMPT,
} from "./input.ts";

const decodeProcessReport = Schema.decodeUnknownOption(
  Schema.Struct({
    method: Schema.Literal("_hermes/process"),
    params: Schema.Struct({ processId: Schema.String, status: Schema.String }),
  }),
);

/**
 * Hermes arms no wake for this process, so only its `_hermes/process` reports list it, and Stop
 * clears it only once Hermes reports that the process it was asked to stop has exited.
 */
export function assertHermesBackgroundProcessStopOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [HERMES_BACKGROUND_PROCESS_STOP_PROMPT]);

  const reports = transcript.entries.flatMap((entry) => {
    const report = entry.type === "emit_inbound" ? decodeProcessReport(entry.frame) : Option.none();
    return Option.isSome(report) ? [report.value.params] : [];
  });
  assert.deepEqual(
    reports.map((report) => report.status),
    ["running", "exited"],
  );
  const before = result.capturedShellSnapshots
    .get("before-stop")
    ?.threads.find((thread) => thread.id === projection.thread.id);
  assert.deepEqual(before?.pendingBackgroundTasks, [
    {
      taskId: reports[0]!.processId,
      kind: "command",
      description: HERMES_BACKGROUND_PROCESS_STOP_COMMAND,
    },
  ]);

  const shell = result.shellSnapshot.threads.find((thread) => thread.id === projection.thread.id);
  assert.deepEqual(shell?.pendingBackgroundTasks ?? [], []);
  assert.deepEqual(projection.providerThreads[0]?.pendingBackgroundTasks ?? [], []);
}
