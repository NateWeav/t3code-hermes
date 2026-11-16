import { createThreadMoveAtoms } from "@t3tools/client-runtime/state/thread-move";

import { connectionAtomRuntime } from "../connection/runtime";

export const threadMove = createThreadMoveAtoms(connectionAtomRuntime);
