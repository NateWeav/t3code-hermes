import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

export const threadMoveDialogAtom = Atom.make<ScopedThreadRef | null>(null).pipe(Atom.keepAlive);

export function openThreadMoveDialog(threadRef: ScopedThreadRef) {
  appAtomRegistry.set(threadMoveDialogAtom, threadRef);
}
