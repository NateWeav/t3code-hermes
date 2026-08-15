import { CommandId, type RuntimeMode } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";

import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import type { ProviderRuntimeBindingWithMetadata } from "../Services/ProviderSessionDirectory.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { forkParked } from "../../serverActivation.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_ACTIVE_TURN_INACTIVITY_THRESHOLD_MS = 2 * 60 * 60 * 1000;
const DEFAULT_STOP_TIMEOUT_MS = 15_000;

export interface ProviderSessionReaperLiveOptions {
  readonly inactivityThresholdMs?: number;
  readonly sweepIntervalMs?: number;
  readonly activeTurnInactivityThresholdMs?: number;
  readonly stopTimeoutMs?: number;
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;

    const inactivityThresholdMs = Math.max(
      1,
      options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS,
    );
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const activeTurnInactivityThresholdMs = Math.max(
      inactivityThresholdMs,
      options?.activeTurnInactivityThresholdMs ?? DEFAULT_ACTIVE_TURN_INACTIVITY_THRESHOLD_MS,
    );
    const stopTimeoutMs = Math.max(1, options?.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);

    const reconcileStoppedProjection = (binding: ProviderRuntimeBindingWithMetadata, now: number) =>
      Effect.gen(function* () {
        const thread = yield* projectionSnapshotQuery
          .getThreadShellById(binding.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        if (
          thread?.session?.status !== "starting" &&
          thread?.session?.status !== "running" &&
          thread?.session?.activeTurnId == null
        ) {
          return;
        }

        const updatedAt = DateTime.formatIso(DateTime.nowUnsafe());
        const runtimeMode: RuntimeMode = binding.runtimeMode ?? "approval-required";
        yield* orchestrationEngine.dispatch({
          type: "thread.session.set",
          commandId: CommandId.make(`provider-session-recovery:${binding.threadId}:${now}`),
          threadId: binding.threadId,
          session: {
            threadId: binding.threadId,
            status: "interrupted",
            providerName: binding.provider,
            ...(binding.providerInstanceId !== undefined
              ? { providerInstanceId: binding.providerInstanceId }
              : {}),
            runtimeMode,
            activeTurnId: null,
            lastError: "Provider process ended before the turn completed. Send a message to retry.",
            updatedAt,
          },
          createdAt: updatedAt,
        });
        yield* Effect.logWarning("provider.session.reaper.reconciled-stale-projection", {
          threadId: binding.threadId,
          provider: binding.provider,
          previousStatus: thread.session?.status,
          previousActiveTurnId: thread.session?.activeTurnId,
        });
      });

    const sweep = Effect.gen(function* () {
      const bindings = yield* directory.listBindings();
      const now = yield* Clock.currentTimeMillis;
      let reapedCount = 0;

      for (const binding of bindings) {
        if (binding.status === "stopped") {
          yield* reconcileStoppedProjection(binding, now).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("provider.session.reaper.reconcile-failed", {
                threadId: binding.threadId,
                provider: binding.provider,
                cause,
              }),
            ),
          );
          continue;
        }

        const lastSeenMs = Date.parse(binding.lastSeenAt);
        if (Number.isNaN(lastSeenMs)) {
          yield* Effect.logWarning("provider.session.reaper.invalid-last-seen", {
            threadId: binding.threadId,
            provider: binding.provider,
            lastSeenAt: binding.lastSeenAt,
          });
          continue;
        }

        const idleDurationMs = now - lastSeenMs;
        if (idleDurationMs < inactivityThresholdMs) {
          continue;
        }

        const thread = yield* projectionSnapshotQuery
          .getThreadShellById(binding.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        if (thread?.session?.activeTurnId != null) {
          if (idleDurationMs >= activeTurnInactivityThresholdMs) {
            yield* Effect.logWarning("provider.session.reaper.stale-active-turn", {
              threadId: binding.threadId,
              activeTurnId: thread.session.activeTurnId,
              idleDurationMs,
            });
          } else {
            yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
              threadId: binding.threadId,
              activeTurnId: thread.session.activeTurnId,
              idleDurationMs,
            });
            continue;
          }
        }

        // The turn can settle while background work runs on (subagent
        // fleets, workflow runs, Monitor watch loops). Those live inside the
        // provider process, so stopping the session would kill them silently,
        // and nothing bumps lastSeenAt between turns.
        if (thread?.backgroundLiveness != null) {
          yield* Effect.logDebug("provider.session.reaper.skipped-background-work", {
            threadId: binding.threadId,
            backgroundLiveness: thread.backgroundLiveness,
            idleDurationMs,
          });
          continue;
        }

        const reaped = yield* providerService.stopSession({ threadId: binding.threadId }).pipe(
          Effect.timeout(Duration.millis(stopTimeoutMs)),
          Effect.tap(() =>
            Effect.logInfo("provider.session.reaped", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              reason: "inactivity_threshold",
            }),
          ),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.stop-failed", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );

        if (reaped) {
          reapedCount += 1;
          const stoppedBinding = yield* directory
            .listBindings()
            .pipe(
              Effect.map((currentBindings) =>
                currentBindings.find((current) => current.threadId === binding.threadId),
              ),
            );
          if (stoppedBinding?.status === "stopped") {
            yield* reconcileStoppedProjection(stoppedBinding, now).pipe(Effect.ignore);
          }
        }
      }

      if (reapedCount > 0) {
        yield* Effect.logInfo("provider.session.reaper.sweep-complete", {
          reapedCount,
          totalBindings: bindings.length,
        });
      }
    });

    const start: ProviderSessionReaperShape["start"] = () =>
      Effect.gen(function* () {
        yield* forkParked(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-failed", {
                error,
              }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("provider.session.reaper.started", {
          inactivityThresholdMs,
          activeTurnInactivityThresholdMs,
          stopTimeoutMs,
          sweepIntervalMs,
        });
      });

    return {
      start,
    } satisfies ProviderSessionReaperShape;
  });

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options));

export const ProviderSessionReaperLive = makeProviderSessionReaperLive();
