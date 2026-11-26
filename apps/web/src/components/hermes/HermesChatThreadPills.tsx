/**
 * One pill per Hermes gateway conversation linked to a thread, shown with the
 * thread details. Each opens its conversation in the right panel; with status
 * rings on, a pill is outlined while Hermes works in it and once it has news.
 */
import {
  formatHermesChatAge,
  hermesChatConversationTitle,
  hermesChatPillStatus,
} from "@t3tools/client-runtime/state/hermesChat";
import type { HermesChatThreadConversation, ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";
import { MessagesSquare } from "lucide-react";

import { useClientSettings } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { useHermesEnvironmentEnabled } from "~/state/hermesCron";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";

import { resolveThreadStatusRing } from "../Sidebar.logic";
import { ThreadStatusRing } from "../ThreadStatusRing";
import { useHermesChatLiveRefresh } from "./useHermesChatLiveRefresh";
import { useHermesChatMarkSeen } from "./useHermesChatMarkSeen";

const WORKING_RING = resolveThreadStatusRing({ status: "working", isUnread: false });
const DONE_RING = resolveThreadStatusRing({ status: "ready", isUnread: true });

export function HermesChatThreadPills(props: {
  readonly threadRef: ScopedThreadRef;
  /** `stack`: separate pills under the inline card. `section`: the popover card's last section. */
  readonly layout: "stack" | "section";
}) {
  // Only an environment with Hermes is ever asked, so others carry no polling.
  if (!useHermesEnvironmentEnabled(props.threadRef.environmentId)) return null;
  return <LinkedConversationPills {...props} />;
}

function LinkedConversationPills(props: {
  readonly threadRef: ScopedThreadRef;
  readonly layout: "stack" | "section";
}) {
  const gt = useGT();
  const { environmentId, threadId } = props.threadRef;
  const query = useEnvironmentQuery(
    serverEnvironment.hermesChatThreadConversations({ environmentId, input: { threadId } }),
  );
  useHermesChatLiveRefresh(query);
  const statusRings = useClientSettings((settings) => settings.sidebarStatusRings);
  const markSeen = useHermesChatMarkSeen(environmentId);
  const result = query.data;
  if (result === null || result.availability !== "ready" || result.conversations.length === 0) {
    return null;
  }
  const open = (conversation: HermesChatThreadConversation, title: string) => {
    useRightPanelStore.getState().openHermesChat(props.threadRef, conversation.sessionKey, title);
    if (markSeen !== null) void markSeen(conversation.sessionKey).then(query.refresh);
  };
  return (
    <ul
      aria-label={gt("Linked Hermes conversations")}
      className={cn(
        "flex flex-col",
        props.layout === "stack" ? "mt-2 gap-1.5" : "gap-1 border-border/65 p-2 not-first:border-t",
      )}
      data-hermes-chat-thread-pills={props.layout}
    >
      {result.conversations.map((conversation) => {
        const title = hermesChatConversationTitle(conversation);
        const status = statusRings ? hermesChatPillStatus(conversation) : null;
        return (
          // The ring sits on the item, so it traces the pill's outer edge, border included.
          <li key={conversation.sessionKey} className="relative overflow-hidden rounded-md">
            <button
              type="button"
              onClick={() => open(conversation, title)}
              aria-label={gt("Open Hermes conversation {title}", { title })}
              className={cn(
                "flex w-full min-w-0 items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset focus-visible:outline-none",
                props.layout === "stack" && "dropdown-glass",
              )}
            >
              <MessagesSquare className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate text-foreground">{title}</span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {formatHermesChatAge(conversation.lastActivityAt)}
              </span>
            </button>
            <ThreadStatusRing
              ring={status === "working" ? WORKING_RING : status === "done" ? DONE_RING : null}
            />
          </li>
        );
      })}
    </ul>
  );
}
