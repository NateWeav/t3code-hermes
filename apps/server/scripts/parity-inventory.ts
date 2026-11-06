// @effect-diagnostics nodeBuiltinImport:off - A one-shot script that prints fixture facts.
/**
 * Prints the replay-fixture facts the provider-parity eval scores against, as JSON: every
 * scenario's variants with assertion identity, and each compared provider's declared capabilities.
 *   node scripts/parity-inventory.ts > inventory.json
 */
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";

import { ClaudeProviderCapabilitiesV2 } from "../src/orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import { CodexProviderCapabilitiesV2 } from "../src/orchestration-v2/Adapters/CodexAdapterV2.ts";
import { HermesProviderCapabilitiesV2 } from "../src/orchestration-v2/Adapters/HermesAdapterV2.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "../src/orchestration-v2/testkit/fixtures/index.ts";

const assertionIds = new Map<unknown, number>();
const assertionId = (assertOutput: unknown) => {
  const known = assertionIds.get(assertOutput);
  if (known !== undefined) return known;
  assertionIds.set(assertOutput, assertionIds.size + 1);
  return assertionIds.size;
};

const inventory = {
  kind: "t3-parity-inventory",
  version: 1,
  scenarios: ORCHESTRATOR_REPLAY_FIXTURES.map((fixture) => ({
    name: fixture.name,
    variants: fixture.providers.map((variant) => ({
      driver: variant.driver,
      model: variant.modelSelection.model,
      // Same id means the same assertion function: the variant is held to the same contract.
      assertionId: assertionId(variant.assertOutput),
      assertionName: variant.assertOutput.name,
      transcriptExists: NodeFS.existsSync(NodeURL.fileURLToPath(variant.transcriptFile)),
    })),
  })),
  capabilities: {
    claudeAgent: ClaudeProviderCapabilitiesV2,
    codex: CodexProviderCapabilitiesV2,
    hermes: HermesProviderCapabilitiesV2,
  },
};

process.stdout.write(`${JSON.stringify(inventory)}\n`);
process.exit(0);
