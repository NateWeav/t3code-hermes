import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { importedMoveEvents } from "./portableHistory.ts";
import type { MoveHeader, MoveHistory } from "./protocol.ts";

it("imports portable history without native sessions and preserves limit recovery", () => {
  const now = DateTime.makeUnsafe("2026-01-01T00:00:00.000Z");
  const header: MoveHeader = {
    id: "00000000-0000-4000-8000-000000000001",
    sourceEnvironmentId: EnvironmentId.make("00000000-0000-4000-8000-000000000002"),
    sourceLabel: "Source",
    sourceThreadId: ThreadId.make("source"),
    title: "Continue work",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    resumeAtReset: true,
  };
  const thread: OrchestrationV2AppThread = {
    id: ThreadId.make("destination"),
    projectId: ProjectId.make("destination-project"),
    title: header.title,
    modelSelection: header.modelSelection,
    providerInstanceId: header.modelSelection.instanceId,
    runtimeMode: header.runtimeMode,
    interactionMode: header.interactionMode,
    branch: "main",
    worktreePath: "/repo/moved",
    activeProviderThreadId: null,
    historyOrigin: "portable_import",
    forkedFrom: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: ThreadId.make("destination"),
    },
    createdBy: "user",
    creationSource: "server",
    createdAt: now,
    updatedAt: now,
    archivedAt: now,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const attachment = {
    type: "file" as const,
    id: "source-file",
    name: "notes.txt",
    mimeType: "text/plain",
    sizeBytes: 4,
  };
  const item: OrchestrationV2TurnItem = {
    id: TurnItemId.make("source-item"),
    threadId: header.sourceThreadId,
    runId: RunId.make("source-run"),
    nodeId: null,
    providerThreadId: ProviderThreadId.make("claude-session"),
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    type: "user_message",
    createdBy: "user",
    creationSource: "web",
    messageId: MessageId.make("source-message"),
    text: "Finish the change",
    attachments: [attachment],
    inputIntent: "turn_start",
  };
  const history: MoveHistory = {
    snapshot: {
      head: "a".repeat(40),
      checkpoint: "b".repeat(40),
      branch: "main",
      prefix: "",
      remotes: [],
      upstream: null,
    },
    items: [item],
    attachments: [attachment],
    limit: {
      completedAt: DateTime.formatIso(now),
      failure: {
        class: "usage_limit",
        message: "Limit reached",
        code: null,
        retryable: true,
        resetAt: "2026-01-01T01:00:00.000Z",
      },
    },
  };
  const imported = importedMoveEvents({ header, history, thread });
  const messages = imported.events.flatMap((event) =>
    event.type === "message.updated" ? [event] : [],
  );
  const turns = imported.events.flatMap((event) =>
    event.type === "turn-item.updated" ? [event] : [],
  );
  assert.equal(messages[0]?.payload.text, item.text);
  assert.equal(messages[0]?.payload.runId, null);
  assert.notEqual(imported.attachments[0]?.id, attachment.id);
  assert.deepEqual(messages[0]?.payload.attachments, imported.attachments);
  assert.equal(turns[0]?.payload.providerThreadId, null);
  assert.equal(turns[0]?.payload.threadId, thread.id);
  assert.equal(turns[0]?.payload.runId, null);
  const run = imported.events.find((event) => event.type === "run.created");
  assert.equal(run?.payload.providerInstanceId, header.modelSelection.instanceId);
  assert.equal(run?.payload.status, "failed");
  assert.equal(run?.payload.userMessageId, messages[0]?.payload.id);
  assert.equal(turns.at(-1)?.payload.type, "error");
  assert.deepEqual(importedMoveEvents({ header, history, thread }), imported);
});
