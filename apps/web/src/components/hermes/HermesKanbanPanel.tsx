/**
 * The read-only Board surface: Hermes Kanban boards read straight from their databases through
 * the server. Overview → a board's milestones (or columns) → one card. Nothing here writes; Hermes
 * stays the source of truth.
 */
import {
  HERMES_KANBAN_DEFAULT_COLUMNS,
  describeHermesKanbanAvailability,
  formatHermesKanbanAge,
  hermesKanbanColumnCards,
  hermesKanbanMilestoneView,
  hermesKanbanProgressPercent,
  hermesKanbanStatusLabel,
  hermesKanbanStatusTone,
  sortHermesKanbanBoards,
} from "@t3tools/client-runtime/state/hermesKanban";
import type { EnvironmentId, HermesKanbanBoardSummary, HermesKanbanTask } from "@t3tools/contracts";
import {
  ArrowLeftIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDotIcon,
  CircleIcon,
  GitBranchIcon,
  SquareKanban,
} from "lucide-react";
import { type ReactNode, useState } from "react";

import { readLocalApi } from "~/localApi";
import { useHermesEnvironmentEnabled } from "~/state/hermesCron";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";

import ChatMarkdown from "../ChatMarkdown";
import { MarkdownThreadLink } from "../chat/MarkdownThreadLink";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { RefreshIcon } from "../ui/refresh-icon";
import { ScrollArea } from "../ui/scroll-area";
import { Skeleton } from "../ui/skeleton";

type BoardMode = "milestones" | "columns";

const ROW_BUTTON_CLASS =
  "w-full rounded-md text-left outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset";

function openExternal(url: string) {
  const api = readLocalApi();
  if (api) void api.shell.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

function StatusGlyph({ status }: { readonly status: string }) {
  const tone = hermesKanbanStatusTone(status);
  const className = "size-3.5 shrink-0";
  const label = hermesKanbanStatusLabel(status);
  switch (tone) {
    case "done":
      return <CircleCheckIcon aria-label={label} className={`${className} text-success`} />;
    case "active":
      return <CircleDotIcon aria-label={label} className={`${className} text-info`} />;
    case "blocked":
      return <CircleAlertIcon aria-label={label} className={`${className} text-destructive`} />;
    case "waiting":
      return <CircleIcon aria-label={label} className={`${className} text-muted-foreground`} />;
  }
}

function StatusBadge({ status }: { readonly status: string }) {
  const tone = hermesKanbanStatusTone(status);
  const variant =
    tone === "done"
      ? "success"
      : tone === "active"
        ? "info"
        : tone === "blocked"
          ? "error"
          : "outline";
  return (
    <Badge size="sm" variant={variant}>
      {hermesKanbanStatusLabel(status)}
    </Badge>
  );
}

function ProgressBar(props: {
  readonly done: number;
  readonly total: number;
  readonly color?: string | null;
}) {
  const percent = hermesKanbanProgressPercent(props.done, props.total);
  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <div
        className="h-full rounded-full bg-primary"
        style={{
          width: `${percent}%`,
          ...(props.color ? { backgroundColor: props.color } : {}),
        }}
      />
    </div>
  );
}

function Section(props: {
  readonly title: string;
  readonly count?: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-1">
      <h3 className="flex items-baseline gap-2 px-1 text-xs font-medium text-muted-foreground">
        {props.title}
        {props.count === undefined ? null : <span className="tabular-nums">{props.count}</span>}
      </h3>
      {props.children}
    </section>
  );
}

function EmptyLine({ children }: { readonly children: ReactNode }) {
  return <p className="px-1 text-xs text-muted-foreground">{children}</p>;
}

function LoadingRows() {
  return (
    <div className="flex flex-col gap-2 p-3" aria-busy>
      <Skeleton className="h-5 w-40" />
      <Skeleton className="h-16" />
      <Skeleton className="h-16" />
    </div>
  );
}

function PanelMessage(props: {
  readonly title: string;
  readonly detail: string;
  readonly refreshing?: boolean;
  readonly onRefresh?: () => void;
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SquareKanban />
        </EmptyMedia>
        <EmptyTitle>{props.title}</EmptyTitle>
        <EmptyDescription>{props.detail}</EmptyDescription>
      </EmptyHeader>
      {props.onRefresh === undefined ? null : (
        <Button
          size="sm"
          variant="outline"
          disabled={props.refreshing === true}
          onClick={props.onRefresh}
        >
          <RefreshIcon refreshing={props.refreshing === true} />
          Try again
        </Button>
      )}
    </Empty>
  );
}

function PanelHeader(props: {
  readonly title: ReactNode;
  readonly subtitle?: ReactNode;
  readonly onBack?: () => void;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
  readonly children?: ReactNode;
}) {
  return (
    <header className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
      {props.onBack === undefined ? null : (
        <Button size="icon-xs" variant="ghost" aria-label="Back" onClick={props.onBack}>
          <ArrowLeftIcon />
        </Button>
      )}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{props.title}</p>
        {props.subtitle === undefined ? null : (
          <p className="truncate text-2xs text-muted-foreground">{props.subtitle}</p>
        )}
      </div>
      {props.children}
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Refresh"
        disabled={props.refreshing}
        onClick={props.onRefresh}
      >
        <RefreshIcon refreshing={props.refreshing} />
      </Button>
    </header>
  );
}

export function HermesKanbanPanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const enabled = useHermesEnvironmentEnabled(environmentId);
  const [slug, setSlug] = useState<string | null>(null);
  const [taskId, setTaskId] = useState<string | null>(null);
  const [mode, setMode] = useState<BoardMode>("milestones");

  if (!enabled) {
    const off = describeHermesKanbanAvailability("hermes-off");
    return <PanelMessage title={off?.title ?? "Hermes is off"} detail={off?.detail ?? ""} />;
  }
  if (slug !== null && taskId !== null) {
    return (
      <HermesKanbanTaskView
        environmentId={environmentId}
        slug={slug}
        taskId={taskId}
        onBack={() => setTaskId(null)}
      />
    );
  }
  if (slug !== null) {
    return (
      <HermesKanbanBoardView
        environmentId={environmentId}
        slug={slug}
        mode={mode}
        onModeChange={setMode}
        onBack={() => setSlug(null)}
        onOpenTask={setTaskId}
      />
    );
  }
  return <HermesKanbanOverview environmentId={environmentId} onOpenBoard={setSlug} />;
}

function HermesKanbanOverview(props: {
  readonly environmentId: EnvironmentId;
  readonly onOpenBoard: (slug: string) => void;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.hermesKanbanListBoards({ environmentId: props.environmentId, input: {} }),
  );
  const result = query.data;
  if (result === null) {
    return query.error === null ? (
      <LoadingRows />
    ) : (
      <PanelMessage
        title="Boards unavailable"
        detail={query.error}
        refreshing={query.isPending}
        onRefresh={query.refresh}
      />
    );
  }
  const unavailable = describeHermesKanbanAvailability(result.availability);
  if (unavailable !== null) {
    return (
      <PanelMessage
        title={unavailable.title}
        detail={unavailable.detail}
        refreshing={query.isPending}
        onRefresh={query.refresh}
      />
    );
  }
  const boards = sortHermesKanbanBoards(result.boards);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title="Boards"
        subtitle={`${boards.length} ${boards.length === 1 ? "board" : "boards"}`}
        refreshing={query.isPending}
        onRefresh={query.refresh}
      />
      <ScrollArea className="min-h-0 flex-1">
        {boards.length === 0 ? (
          <PanelMessage
            title="No boards yet"
            detail="Create one with `hermes kanban boards create <slug>` and it shows up here."
          />
        ) : (
          <ul className="grid gap-2 p-3">
            {boards.map((board) => (
              <li key={board.slug}>
                <BoardCard board={board} onOpen={() => props.onOpenBoard(board.slug)} />
              </li>
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}

function BoardCard(props: {
  readonly board: HermesKanbanBoardSummary;
  readonly onOpen: () => void;
}) {
  const { board } = props;
  return (
    <button
      type="button"
      onClick={props.onOpen}
      className="flex w-full flex-col gap-2 rounded-xl border border-border/60 border-l-4 bg-card px-3 py-2.5 text-left outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      style={board.color ? { borderLeftColor: board.color } : undefined}
    >
      <div className="flex items-center gap-2">
        {board.icon ? <span aria-hidden>{board.icon}</span> : null}
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{board.name}</span>
        <span className="text-2xs text-muted-foreground tabular-nums">
          {formatHermesKanbanAge(board.lastActivityAt)}
        </span>
      </div>
      {board.description ? (
        <p className="line-clamp-1 text-xs text-muted-foreground">{board.description}</p>
      ) : null}
      {board.readable ? (
        <>
          <ProgressBar done={board.doneCount} total={board.taskCount} color={board.color} />
          <div className="flex flex-wrap items-center gap-1.5 text-2xs text-muted-foreground">
            <span className="tabular-nums">
              {board.doneCount}/{board.taskCount} done
            </span>
            {board.runningCount > 0 ? (
              <Badge size="sm" variant="info">
                {board.runningCount} running
              </Badge>
            ) : null}
            {board.blockedCount > 0 ? (
              <Badge size="sm" variant="error">
                {board.blockedCount} blocked
              </Badge>
            ) : null}
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">This board's database could not be read.</p>
      )}
    </button>
  );
}

function TaskChips({ task }: { readonly task: HermesKanbanTask }) {
  const pullRequestUrl = task.pullRequestUrl;
  if (pullRequestUrl === null && task.branch === null) return null;
  return (
    <span className="flex shrink-0 items-center gap-1">
      {pullRequestUrl === null ? null : (
        <Badge
          size="sm"
          variant="outline"
          render={
            <button
              type="button"
              aria-label="Open pull request"
              onClick={(event) => {
                event.stopPropagation();
                openExternal(pullRequestUrl);
              }}
            />
          }
        >
          <PullRequestGlyph.pullRequest />
          {pullRequestUrl.match(/\/pull\/(\d+)/)?.[1] ?? "PR"}
        </Badge>
      )}
      {task.branch === null ? null : (
        <Badge size="sm" variant="outline" className="max-w-32">
          <GitBranchIcon />
          <span className="truncate">{task.branch}</span>
        </Badge>
      )}
    </span>
  );
}

function TaskRow(props: { readonly task: HermesKanbanTask; readonly onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onOpen}
      className={`${ROW_BUTTON_CLASS} flex items-center gap-2 px-1.5 py-1 text-sm`}
    >
      <StatusGlyph status={props.task.status} />
      <span className="min-w-0 flex-1 truncate">{props.task.title}</span>
      <TaskChips task={props.task} />
    </button>
  );
}

function HermesKanbanBoardView(props: {
  readonly environmentId: EnvironmentId;
  readonly slug: string;
  readonly mode: BoardMode;
  readonly onModeChange: (mode: BoardMode) => void;
  readonly onBack: () => void;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.hermesKanbanGetBoard({
      environmentId: props.environmentId,
      input: { slug: props.slug },
    }),
  );
  const result = query.data;
  const header = (title: ReactNode, subtitle?: ReactNode) => (
    <PanelHeader
      title={title}
      subtitle={subtitle}
      onBack={props.onBack}
      refreshing={query.isPending}
      onRefresh={query.refresh}
    >
      {result?.board ? (
        <div className="flex rounded-md border border-border/60 p-0.5" role="group">
          {(["milestones", "columns"] as const).map((mode) => (
            <Button
              key={mode}
              size="xs"
              variant={props.mode === mode ? "secondary" : "ghost"}
              aria-pressed={props.mode === mode}
              onClick={() => props.onModeChange(mode)}
            >
              {mode === "milestones" ? "Milestones" : "Columns"}
            </Button>
          ))}
        </div>
      ) : null}
    </PanelHeader>
  );
  if (result === null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header(props.slug)}
        {query.error === null ? (
          <LoadingRows />
        ) : (
          <PanelMessage
            title="Board unavailable"
            detail={query.error}
            refreshing={query.isPending}
            onRefresh={query.refresh}
          />
        )}
      </div>
    );
  }
  const unavailable = describeHermesKanbanAvailability(result.availability);
  const board = result.board;
  if (unavailable !== null || board === null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {header(props.slug)}
        <PanelMessage
          title={unavailable?.title ?? "Board not found"}
          detail={unavailable?.detail ?? "Hermes no longer lists this board."}
          refreshing={query.isPending}
          onRefresh={query.refresh}
        />
      </div>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      {header(
        <span className="flex items-center gap-1.5">
          {board.icon ? <span aria-hidden>{board.icon}</span> : null}
          {board.name}
        </span>,
        `${board.doneCount}/${board.taskCount} done · ${formatHermesKanbanAge(board.lastActivityAt)}`,
      )}
      {props.mode === "milestones" ? (
        <ScrollArea className="min-h-0 flex-1">
          <MilestonesList board={result} color={board.color} onOpenTask={props.onOpenTask} />
        </ScrollArea>
      ) : (
        <ColumnsView tasks={result.tasks} onOpenTask={props.onOpenTask} />
      )}
    </div>
  );
}

function MilestonesList(props: {
  readonly board: Parameters<typeof hermesKanbanMilestoneView>[0];
  readonly color: string | null;
  readonly onOpenTask: (taskId: string) => void;
}) {
  const view = hermesKanbanMilestoneView(props.board);
  if (view.features.length === 0 && view.standalone.length === 0) {
    return <PanelMessage title="No cards" detail="This board has no cards yet." />;
  }
  return (
    <div className="flex flex-col gap-4 p-3">
      {view.features.map((feature) => (
        <section
          key={feature.task.id}
          className="flex flex-col gap-2 rounded-xl border border-border/60 bg-card px-2 py-2.5"
        >
          <button
            type="button"
            onClick={() => props.onOpenTask(feature.task.id)}
            className={`${ROW_BUTTON_CLASS} flex flex-col gap-1.5 px-1.5 py-1`}
          >
            <span className="flex items-center gap-2">
              <StatusGlyph status={feature.task.status} />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold">
                {feature.task.title}
              </span>
              <span className="text-2xs text-muted-foreground tabular-nums">
                {feature.doneCount}/{feature.totalCount}
              </span>
            </span>
            <ProgressBar done={feature.doneCount} total={feature.totalCount} color={props.color} />
          </button>
          <ul className="flex flex-col">
            {feature.milestones.map((milestone) => (
              <li key={milestone.id}>
                <TaskRow task={milestone} onOpen={() => props.onOpenTask(milestone.id)} />
              </li>
            ))}
          </ul>
        </section>
      ))}
      {view.standalone.length === 0 ? null : (
        <Section title="Cards" count={String(view.standalone.length)}>
          <ul className="flex flex-col">
            {view.standalone.map((task) => (
              <li key={task.id}>
                <TaskRow task={task} onOpen={() => props.onOpenTask(task.id)} />
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function ColumnsView(props: {
  readonly tasks: readonly HermesKanbanTask[];
  readonly onOpenTask: (taskId: string) => void;
}) {
  const columns = hermesKanbanColumnCards(props.tasks, HERMES_KANBAN_DEFAULT_COLUMNS);
  return (
    <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto p-3">
      {columns.map(({ column, tasks }) => (
        <section
          key={column.id}
          className="flex min-h-0 w-56 shrink-0 flex-col gap-1 rounded-xl bg-muted/40 p-1.5"
        >
          <h3 className="flex items-baseline gap-2 px-1 text-xs font-medium text-muted-foreground">
            {column.label}
            <span className="tabular-nums">{tasks.length}</span>
          </h3>
          <ScrollArea className="min-h-0 flex-1">
            {tasks.length === 0 ? (
              <EmptyLine>Nothing here.</EmptyLine>
            ) : (
              <ul className="flex flex-col gap-1">
                {tasks.map((task) => (
                  <li key={task.id}>
                    <button
                      type="button"
                      onClick={() => props.onOpenTask(task.id)}
                      className="flex w-full flex-col gap-1 rounded-lg border border-border/60 bg-card px-2 py-1.5 text-left text-sm outline-none hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                    >
                      <span className="line-clamp-2">{task.title}</span>
                      <span className="flex items-center gap-1.5">
                        <StatusGlyph status={task.status} />
                        <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">
                          {hermesKanbanStatusLabel(task.status)}
                        </span>
                        <TaskChips task={task} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </ScrollArea>
        </section>
      ))}
    </div>
  );
}

function formatTimestamp(iso: string | null): string | null {
  if (iso === null) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? new Date(at).toLocaleString() : null;
}

function HermesKanbanTaskView(props: {
  readonly environmentId: EnvironmentId;
  readonly slug: string;
  readonly taskId: string;
  readonly onBack: () => void;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.hermesKanbanGetTask({
      environmentId: props.environmentId,
      input: { slug: props.slug, taskId: props.taskId },
    }),
  );
  const result = query.data;
  const task = result?.task ?? null;
  const headerProps = {
    onBack: props.onBack,
    refreshing: query.isPending,
    onRefresh: query.refresh,
  };
  if (result === null || task === null) {
    const unavailable = result ? describeHermesKanbanAvailability(result.availability) : null;
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PanelHeader title={props.taskId} {...headerProps} />
        {result === null && query.error === null ? (
          <LoadingRows />
        ) : (
          <PanelMessage
            title={unavailable?.title ?? "Card unavailable"}
            detail={
              unavailable?.detail ?? query.error ?? "The card is gone, archived, or unreadable."
            }
            refreshing={query.isPending}
            onRefresh={query.refresh}
          />
        )}
      </div>
    );
  }
  const timestamps = (
    [
      ["Created", task.createdAt],
      ["Started", task.startedAt],
      ["Completed", task.completedAt],
    ] as const
  ).flatMap(([label, iso]) => {
    const text = formatTimestamp(iso);
    return text === null ? [] : [{ label, text }];
  });
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader title={task.title} subtitle={task.id} {...headerProps} />
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-3">
          <div className="flex flex-wrap items-center gap-1.5">
            <StatusBadge status={task.status} />
            <TaskChips task={task} />
            {task.assignee ? (
              <span className="text-2xs text-muted-foreground">@{task.assignee}</span>
            ) : null}
          </div>
          {task.threadId === null ? null : (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              Thread
              <MarkdownThreadLink
                environmentId={props.environmentId}
                threadId={task.threadId}
                label={task.title}
              />
            </div>
          )}
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
            {timestamps.map((entry) => (
              <div key={entry.label} className="contents">
                <dt className="text-muted-foreground">{entry.label}</dt>
                <dd className="tabular-nums">{entry.text}</dd>
              </div>
            ))}
          </dl>
          {task.body ? (
            <div className="text-sm">
              <ChatMarkdown text={task.body} cwd={undefined} environmentId={props.environmentId} />
            </div>
          ) : null}
          {task.result ? (
            <Section title="Result">
              <div className="rounded-lg border border-border/60 px-2 py-1.5 text-sm">
                <ChatMarkdown
                  text={task.result}
                  cwd={undefined}
                  environmentId={props.environmentId}
                />
              </div>
            </Section>
          ) : null}
          <Section title="Comments" count={String(result.comments.length)}>
            {result.comments.length === 0 ? (
              <EmptyLine>No comments yet.</EmptyLine>
            ) : (
              <ul className="flex flex-col gap-2">
                {result.comments.map((comment) => (
                  <li
                    key={comment.id}
                    className="flex flex-col gap-1 rounded-lg border border-border/60 px-2 py-1.5"
                  >
                    <span className="flex items-baseline gap-2 text-2xs text-muted-foreground">
                      <span className="font-medium text-foreground">{comment.author}</span>
                      {formatHermesKanbanAge(comment.createdAt)}
                    </span>
                    <div className="text-sm">
                      <ChatMarkdown
                        text={comment.body}
                        cwd={undefined}
                        environmentId={props.environmentId}
                      />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </Section>
        </div>
      </ScrollArea>
    </div>
  );
}
