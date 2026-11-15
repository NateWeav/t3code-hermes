import type { ScopedThreadRef } from "@t3tools/contracts";
import { createThreadMoveAtoms } from "@t3tools/client-runtime/state/thread-move";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

export const threadMoveSheetAtom = Atom.make<ScopedThreadRef | null>(null).pipe(Atom.keepAlive);
export const threadMove = createThreadMoveAtoms(connectionAtomRuntime);
