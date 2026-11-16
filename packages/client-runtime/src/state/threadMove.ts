import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createEnvironmentRpcCommand, createEnvironmentRpcQueryAtomFamily } from "./runtime.ts";

export function createThreadMoveAtoms<R, E>(runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>) {
  return {
    models: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "thread-move:models",
      tag: WS_METHODS.threadMoveModels,
      staleTimeMs: 10_000,
    }),
    move: createEnvironmentRpcCommand(runtime, {
      label: "thread-move:move",
      tag: WS_METHODS.threadMove,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.threadId}`,
      },
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "thread-move:cancel",
      tag: WS_METHODS.threadMoveCancel,
    }),
  };
}
