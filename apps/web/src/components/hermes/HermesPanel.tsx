/**
 * Hermes panel — a full-page view opened from the sidebar, mirroring Usage.
 *
 * Two tabs: Tasks (Hermes's scheduled jobs) and Memory (what the agent
 * remembers, via Hindsight). The tab list is data, so adding a third is one
 * entry plus one component.
 *
 * Both tabs render unconditionally and speak for themselves when their backing
 * service is absent. A tab that appears only once a network read lands would
 * shift the strip after mount and would hide the one screen that tells someone
 * whether the thing they just configured is working.
 */
import { HERMES_NEW_TASK_TEMPLATE } from "@t3tools/client-runtime/state/hermes-cron";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { requestComposerTemplate } from "../../composerTemplateBus";
import { cn } from "../../lib/utils";
import { markHermesTasksSeen } from "../../state/hermesCronSeen";
import { useHermesEnvironmentId } from "../../state/hermesCron";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { HermesMemoryTab } from "./HermesMemoryTab";
import { HermesTasksTab } from "./HermesTasksTab";

type HermesTab = "tasks" | "memory";

const TABS: ReadonlyArray<{ readonly value: HermesTab; readonly label: string }> = [
  { value: "tasks", label: "Tasks" },
  { value: "memory", label: "Memory" },
];

export function HermesPanel() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<HermesTab>("tasks");
  const environmentId = useHermesEnvironmentId();

  // Opening the panel is what clears the sidebar's unread dot.
  useEffect(() => {
    if (environmentId !== null) markHermesTasksSeen(environmentId);
  }, [environmentId]);

  const handleNewTask = useCallback(() => {
    requestComposerTemplate(HERMES_NEW_TASK_TEMPLATE);
    void navigate({ to: "/" });
  }, [navigate]);

  return (
    <SidebarInset className="isolate h-dvh min-h-0 overflow-hidden">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-center gap-2 px-4 py-3">
          <WorkspaceBreadcrumb ariaLabel="Hermes breadcrumb">
            <WorkspaceBreadcrumbItem current>Hermes</WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </header>

        <nav
          aria-label="Hermes tabs"
          className="flex shrink-0 items-center gap-1 border-b border-border/60 px-4 pb-2"
        >
          {TABS.map((item) => (
            <button
              key={item.value}
              type="button"
              aria-pressed={tab === item.value}
              onClick={() => setTab(item.value)}
              className={cn(
                "inline-flex items-center rounded-md px-3 py-1.5 text-xs transition-colors",
                tab === item.value
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 px-6 py-5">
            {tab === "tasks" ? <HermesTasksTab onNewTask={handleNewTask} /> : <HermesMemoryTab />}
          </div>
        </ScrollArea>
      </div>
    </SidebarInset>
  );
}
