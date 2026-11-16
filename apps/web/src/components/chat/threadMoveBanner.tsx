import type { ScopedThreadRef, ThreadMoveState } from "@t3tools/contracts";
import { ArrowRightLeftIcon } from "lucide-react";

import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { openThreadMoveDialog } from "./threadMoveDialogState";

export function threadMoveBannerItem(
  threadRef: ScopedThreadRef,
  move: ThreadMoveState | null | undefined,
): ComposerBannerStackItem | null {
  if (move == null || move.direction !== "outgoing") return null;
  const complete = move.phase === "complete";
  return {
    id: "thread-move",
    variant: complete ? "info" : "warning",
    group: "environment",
    icon: <ArrowRightLeftIcon />,
    title: complete ? `Moved to ${move.label}` : `Moving to ${move.label}`,
    description: complete
      ? "This thread continues on the other machine. This copy is read-only."
      : "The move has not finished. Retry it, or cancel to keep working here.",
    actions: (
      <Button size="xs" variant="ghost" onClick={() => openThreadMoveDialog(threadRef)}>
        {complete ? "Open" : "Retry or cancel"}
      </Button>
    ),
  };
}
