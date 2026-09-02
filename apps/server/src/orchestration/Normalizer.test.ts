// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  CommandId,
  type ClientOrchestrationCommand,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { canonicalizeClientCommandTimestamps, normalizeDispatchCommand } from "./Normalizer.ts";

const clientCreatedAt = "2031-01-01T00:00:00.000Z";
const serverReceivedAt = "2026-07-18T00:00:00.000Z";

const makeNormalizerLayer = () =>
  Layer.mergeAll(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-normalizer-test-" }),
    WorkspacePaths.layer,
  ).pipe(Layer.provideMerge(NodeServices.layer));

describe("canonicalizeClientCommandTimestamps", () => {
  it("replaces a client command timestamp with the server receipt timestamp", () => {
    const command: ClientOrchestrationCommand = {
      type: "project.create",
      commandId: CommandId.make("command-1"),
      projectId: ProjectId.make("project-1"),
      title: "Clock-safe project",
      workspaceRoot: "/tmp/clock-safe-project",
      createdAt: clientCreatedAt,
    };

    expect(canonicalizeClientCommandTimestamps(command, serverReceivedAt)).toEqual({
      ...command,
      createdAt: serverReceivedAt,
    });
  });

  it("replaces both timestamps when the first turn bootstraps a thread", () => {
    const command: ClientOrchestrationCommand = {
      type: "thread.turn.start",
      commandId: CommandId.make("command-2"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: MessageId.make("message-1"),
        role: "user",
        text: "Start a thread",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: ProjectId.make("project-1"),
          title: "Clock-safe thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: clientCreatedAt,
        },
      },
      createdAt: clientCreatedAt,
    };

    const result = canonicalizeClientCommandTimestamps(command, serverReceivedAt);

    expect(result.type).toBe("thread.turn.start");
    if (result.type !== "thread.turn.start") {
      throw new Error("Expected a thread.turn.start command");
    }
    expect(result.createdAt).toBe(serverReceivedAt);
    expect(result.bootstrap?.createThread?.createdAt).toBe(serverReceivedAt);
  });
});

describe("normalizeDispatchCommand attachments", () => {
  it.effect("persists binary generic files with a safe original extension", () =>
    Effect.gen(function* () {
      const command: ClientOrchestrationCommand = {
        type: "thread.turn.start",
        commandId: CommandId.make("command-file-1"),
        threadId: ThreadId.make("thread-file-1"),
        message: {
          messageId: MessageId.make("message-file-1"),
          role: "user",
          text: "Inspect this binary",
          attachments: [
            {
              type: "file",
              name: "../../payload.dat",
              mimeType: "application/octet-stream",
              sizeBytes: 4,
              dataUrl: "data:application/octet-stream;base64,AP+AQA==",
            },
          ],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: clientCreatedAt,
      };

      const result = yield* normalizeDispatchCommand(command);
      expect(result.type).toBe("thread.turn.start");
      if (result.type !== "thread.turn.start") throw new Error("Expected thread.turn.start");
      const attachment = result.message.attachments[0];
      expect(attachment?.type).toBe("file");
      if (!attachment) throw new Error("Expected persisted attachment");

      const config = yield* ServerConfig.ServerConfig;
      const persistedPath = `${config.attachmentsDir}/${attachment.id}.dat`;
      expect([...NodeFS.readFileSync(persistedPath)]).toEqual([0, 255, 128, 64]);
      expect(NodeFS.existsSync(`${config.attachmentsDir}/${attachment.name}`)).toBe(false);
    }).pipe(Effect.provide(makeNormalizerLayer()), Effect.scoped),
  );

  it.effect("rejects file payloads whose declared size does not match decoded bytes", () =>
    Effect.gen(function* () {
      const command = {
        type: "thread.turn.start",
        commandId: CommandId.make("command-file-2"),
        threadId: ThreadId.make("thread-file-2"),
        message: {
          messageId: MessageId.make("message-file-2"),
          role: "user",
          text: "Inspect this",
          attachments: [
            {
              type: "file",
              name: "mismatch.bin",
              mimeType: "application/octet-stream",
              sizeBytes: 1,
              dataUrl: "data:application/octet-stream;base64,AP+AQA==",
            },
          ],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: clientCreatedAt,
      } satisfies ClientOrchestrationCommand;

      const exit = yield* Effect.exit(normalizeDispatchCommand(command));
      expect(exit._tag).toBe("Failure");
    }).pipe(Effect.provide(makeNormalizerLayer()), Effect.scoped),
  );

  it.effect("persists an empty generic file", () =>
    Effect.gen(function* () {
      const command: ClientOrchestrationCommand = {
        type: "thread.turn.start",
        commandId: CommandId.make("command-file-empty"),
        threadId: ThreadId.make("thread-file-empty"),
        message: {
          messageId: MessageId.make("message-file-empty"),
          role: "user",
          text: "Inspect this empty file",
          attachments: [
            {
              type: "file",
              name: "empty.txt",
              mimeType: "text/plain",
              sizeBytes: 0,
              dataUrl: "data:text/plain;base64,",
            },
          ],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: clientCreatedAt,
      };

      const result = yield* normalizeDispatchCommand(command);
      expect(result.type).toBe("thread.turn.start");
      if (result.type !== "thread.turn.start") throw new Error("Expected thread.turn.start");
      const attachment = result.message.attachments[0];
      if (!attachment) throw new Error("Expected persisted attachment");

      const config = yield* ServerConfig.ServerConfig;
      const persistedPath = `${config.attachmentsDir}/${attachment.id}.txt`;
      expect(NodeFS.statSync(persistedPath).size).toBe(0);
    }).pipe(Effect.provide(makeNormalizerLayer()), Effect.scoped),
  );
});
