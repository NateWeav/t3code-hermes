import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertReplayLabelPrefixCount,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import { HERMES_TOOL_CALL_DENIED_WRITE_PROMPT } from "./input.ts";

/** The twin's prompt, and one ACP permission request and answer on the wire. */
export function assertHermesToolCallDeniedWriteDetails(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertUserMessagesInclude(projectionFor(result, transcript.scenario), [
    HERMES_TOOL_CALL_DENIED_WRITE_PROMPT,
  ]);
  assertReplayLabelPrefixCount(transcript, "request:session/request_permission", 1);
  assertReplayLabelPrefixCount(transcript, "response:session/request_permission", 1);
}
