import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  ExecutionEndpointId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

it.layer(NodeServices.layer)("thread execution endpoint persistence", (it) => {
  it.effect("copies the immutable endpoint binding into thread.created", () =>
    Effect.gen(function* () {
      const now = "2026-08-26T00:00:00.000Z";
      const projectId = ProjectId.make("project-1");
      const readModel = yield* projectEvent(createEmptyReadModel(now), {
        sequence: 1,
        eventId: "event-project" as never,
        type: "project.created",
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: now,
        commandId: CommandId.make("cmd-project"),
        causationEventId: null,
        correlationId: null,
        metadata: {},
        payload: {
          projectId,
          title: "Project",
          workspaceRoot: "/tmp/project",
          defaultModelSelection: null,
          scripts: [],
          createdAt: now,
          updatedAt: now,
        },
      });
      const executionEndpointId = ExecutionEndpointId.make("build-host");
      const event = yield* decideOrchestrationCommand({
        readModel,
        command: {
          type: "thread.create",
          commandId: CommandId.make("cmd-thread"),
          threadId: ThreadId.make("thread-1"),
          projectId,
          title: "Thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          executionEndpointId,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: now,
        },
      });
      expect(Array.isArray(event)).toBe(false);
      if (!("type" in event)) {
        throw new Error("Expected thread.create to produce one event");
      }
      if (event.type !== "thread.created") {
        throw new Error(`Expected thread.created, got ${event.type}`);
      }
      expect((event.payload as { readonly executionEndpointId?: string }).executionEndpointId).toBe(
        executionEndpointId,
      );
    }),
  );
});
