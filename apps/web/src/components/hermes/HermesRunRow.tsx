import {
  formatHermesRunDuration,
  formatHermesTimestamp,
} from "@t3tools/client-runtime/state/hermes-cron";
import type { EnvironmentId, HermesCronRun, HermesCronRunOutput } from "@t3tools/contracts";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";

/** Mounted only for an expanded run; full output never enters the list subscription. */
function HermesRunOutput({
  environmentId,
  run,
  onRetry,
}: {
  readonly environmentId: EnvironmentId;
  readonly run: HermesCronRun;
  readonly onRetry: () => void;
}) {
  const getOutput = useAtomCommand(serverEnvironment.hermesCronGetRunOutput, {
    reportFailure: false,
  });
  const [result, setResult] = useState<HermesCronRunOutput | "loading" | "error">("loading");
  const available = run.delivery?.contentAvailable === true;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches this run's recorded output from the server and ignores a late reply after unmount
  useEffect(() => {
    if (!available) return;
    let active = true;
    void getOutput({ environmentId, input: { jobId: run.jobId, runId: run.id } }).then(
      (response) => {
        if (active) setResult(response._tag === "Success" ? response.value : "error");
      },
    );
    return () => {
      active = false;
    };
  }, [available, environmentId, getOutput, run.id, run.jobId]);

  if (!available)
    return <p className="text-muted-foreground">No recorded output is available for this run.</p>;
  if (result === "loading")
    return (
      <p role="status" className="text-muted-foreground">
        Loading output…
      </p>
    );
  if (result === "error")
    return (
      <div className="flex items-center gap-2">
        <p role="alert" className="text-destructive">
          Could not load this run’s output.
        </p>
        <Button variant="ghost" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    );
  if (result.content === null)
    return <p className="text-muted-foreground">The recorded output is no longer available.</p>;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-muted-foreground">
        {result.source === "delivery"
          ? "Delivery output"
          : result.source === "session"
            ? "Session output"
            : "Run output"}
      </p>
      <ChatMarkdown text={result.content} cwd={undefined} environmentId={environmentId} />
      {result.truncated ? (
        <p className="text-muted-foreground">Output truncated to the display limit.</p>
      ) : null}
    </div>
  );
}

export function HermesRunRow({
  run,
  environmentId,
  targeted,
}: {
  readonly run: HermesCronRun;
  readonly environmentId: EnvironmentId;
  readonly targeted: boolean;
}) {
  const [expanded, setExpanded] = useState(targeted);
  const rowRef = useRef<HTMLLIElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- scrolls the DOM row into view when a deep link targets this run
  useEffect(() => {
    if (targeted) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [targeted]);
  const [attempt, setAttempt] = useState(0);
  const when = formatHermesTimestamp(run.finishedAt ?? run.startedAt ?? run.claimedAt);
  const duration = formatHermesRunDuration(run.durationMs);
  return (
    <li ref={rowRef} className="flex flex-col gap-1 border-t border-border/40 py-1.5 text-xs">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex items-center gap-2 text-left"
        aria-label={`Run ${run.id}: ${run.status}`}
      >
        <ChevronRightIcon
          className={cn("size-3 shrink-0 text-muted-foreground", expanded && "rotate-90")}
        />
        <span
          className={cn(
            "font-medium",
            run.status === "failed" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {run.status}
        </span>
        {when === null ? null : <span className="text-muted-foreground">{when}</span>}
        {duration === null ? null : <span className="text-muted-foreground">· {duration}</span>}
      </button>
      {run.error === null ? null : (
        <p className="break-words font-mono text-2xs text-destructive">{run.error}</p>
      )}
      {run.delivery ? (
        <p className="text-muted-foreground">
          Delivery: {run.delivery.status === "unrecorded" ? "not recorded" : run.delivery.status}
          {run.delivery.targets.length > 0 ? ` · Target: ${run.delivery.targets.join(", ")}` : ""}
        </p>
      ) : null}
      {run.delivery?.error ? (
        <p className="break-words text-destructive">{run.delivery.error}</p>
      ) : null}
      {expanded ? (
        <div className="min-w-0 py-2 pl-5">
          <HermesRunOutput
            key={attempt}
            environmentId={environmentId}
            run={run}
            onRetry={() => setAttempt((value) => value + 1)}
          />
        </div>
      ) : null}
    </li>
  );
}
