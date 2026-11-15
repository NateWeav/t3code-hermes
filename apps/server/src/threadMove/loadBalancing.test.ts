import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import type { HostResourcesSnapshot, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { canAutomaticallyMove, hasSpareCapacity, isOverloaded } from "./loadBalancing.ts";

const resources = (
  cpuUtilization: number | null,
  availableMemoryBytes = 8 * 1024 ** 3,
): HostResourcesSnapshot => ({
  sampledAt: 0,
  cpuUtilization,
  cpuCount: 8,
  availableMemoryBytes,
  totalMemoryBytes: 16 * 1024 ** 3,
});

const shell = (
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => ({
  createdBy: "user",
  creationSource: "server",
  id: ThreadId.make("thread-test"),
  projectId: ProjectId.make("project-test"),
  title: "Thread",
  providerInstanceId: ProviderInstanceId.make("provider-test"),
  modelSelection: { instanceId: ProviderInstanceId.make("provider-test"), model: "model" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: "/repo/thread",
  lineage: {
    parentThreadId: null,
    relationshipToParent: null,
    rootThreadId: ThreadId.make("thread-test"),
  },
  forkedFrom: null,
  activeProviderThreadId: null,
  latestRunId: RunId.make("run-test"),
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  pendingBackgroundTasks: [],
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 1,
  visibleItemCount: 1,
  createdAt: DateTime.makeUnsafe(0),
  updatedAt: DateTime.makeUnsafe(0),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  ...overrides,
});

it("distinguishes sustained overload from a destination with spare capacity", () => {
  assert.isTrue(isOverloaded(resources(0.95)));
  assert.isTrue(isOverloaded(resources(0.5, 1 * 1024 ** 3)));
  assert.isTrue(hasSpareCapacity(resources(0.4)));
  assert.isFalse(hasSpareCapacity(resources(0.8)));
  assert.isFalse(hasSpareCapacity(resources(null)));
  assert.isFalse(hasSpareCapacity(resources(0.2, 1 * 1024 ** 3)));
  assert.isFalse(isOverloaded(resources(null)));
});

it("selects top-level threads not waiting on a question and without a live sibling", () => {
  const candidate = shell();
  assert.isTrue(canAutomaticallyMove(candidate, [candidate], 60_000));
  const sibling = shell({ id: ThreadId.make("thread-other"), status: "running" });
  assert.isFalse(canAutomaticallyMove(candidate, [candidate, sibling], 60_000));
  assert.isTrue(
    canAutomaticallyMove(
      candidate,
      [candidate, { ...sibling, worktreePath: "/repo/other" }],
      60_000,
    ),
  );
  assert.isTrue(canAutomaticallyMove(sibling, [sibling], 60_000));
  const asking = shell({
    status: "waiting",
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make("request-test"),
      kind: "user_input",
      createdAt: DateTime.makeUnsafe(0),
    },
  });
  assert.isFalse(canAutomaticallyMove(asking, [asking], 60_000));
  const child = shell({
    lineage: {
      ...candidate.lineage,
      parentThreadId: candidate.id,
      relationshipToParent: "subagent",
    },
  });
  assert.isFalse(canAutomaticallyMove(child, [child], 60_000));
  const incoming = shell({
    move: {
      id: "00000000-0000-4000-8000-000000000000",
      direction: "incoming",
      phase: "complete",
      environmentId: EnvironmentId.make("00000000-0000-4000-8000-000000000001"),
      threadId: candidate.id,
      label: "remote",
      startedAt: "1970-01-01T00:00:00.000Z",
      modelSelection: candidate.modelSelection,
      resumeAtReset: false,
      resetAt: null,
    },
  });
  assert.isFalse(canAutomaticallyMove(incoming, [incoming], 60_000));
  assert.isTrue(canAutomaticallyMove(incoming, [incoming], 600_001));
});
