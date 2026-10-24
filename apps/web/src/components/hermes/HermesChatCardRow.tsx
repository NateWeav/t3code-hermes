/**
 * A linked Hermes gateway conversation's card in a thread timeline. The card
 * opens the conversation surface rather than a thread, and Detach removes the
 * link so the server stops refreshing the card here.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { MessagesSquare } from "lucide-react";
import { useState, type ReactNode } from "react";

import { useRightPanelStore } from "~/rightPanelStore";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

import { WorkLogRow } from "../chat/WorkLog";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

export function HermesChatCardRow(props: {
  readonly threadRef: ScopedThreadRef;
  readonly sessionKey: string;
  readonly summary: string;
  readonly detail: string | undefined;
  readonly timestamp: ReactNode;
}) {
  const canOperate = useAtomValue(
    serverEnvironment.hermesChatUnlink.permissionAtom(props.threadRef.environmentId),
  );
  const unlink = useAtomCommand(serverEnvironment.hermesChatUnlink, {
    label: "hermes conversation detach",
  });
  const [detaching, setDetaching] = useState(false);
  const open = () =>
    useRightPanelStore.getState().openHermesChat(props.threadRef, props.sessionKey, props.summary);
  const detach = async () => {
    setDetaching(true);
    const result = await unlink({
      environmentId: props.threadRef.environmentId,
      input: { sessionKey: props.sessionKey, threadId: props.threadRef.threadId },
    });
    setDetaching(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not detach conversation",
          description: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  };
  return (
    <WorkLogRow
      role="button"
      tabIndex={0}
      aria-label={`Open Hermes conversation ${props.summary}`}
      onClick={open}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          open();
        }
      }}
      icon={<MessagesSquare className="size-3.5 shrink-0 text-muted-foreground" />}
      label={props.summary}
      trailing={
        <>
          {canOperate ? (
            <Button
              size="micro"
              variant="ghost"
              disabled={detaching}
              onClick={(event) => {
                event.stopPropagation();
                void detach();
              }}
            >
              Detach
            </Button>
          ) : null}
          {props.timestamp}
        </>
      }
    >
      {props.detail ? (
        <p className="truncate pl-5 text-xs text-muted-foreground">{props.detail}</p>
      ) : null}
    </WorkLogRow>
  );
}
