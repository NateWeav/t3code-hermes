import { useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import type {
  EnvironmentId,
  ModelSelection,
  ScopedThreadRef,
  ThreadMoveResult,
} from "@t3tools/contracts";
import {
  ArrowRightIcon,
  CheckCircle2Icon,
  GitBranchIcon,
  MessageSquareIcon,
  FolderGit2Icon,
} from "lucide-react";
import { useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useQuietThreadProjection, useThreadShell } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { peerLinkEnvironment } from "~/state/peerLinks";
import { useEnvironmentQuery } from "~/state/query";
import { threadMove } from "~/state/threadMove";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { threadMoveDialogAtom } from "./threadMoveDialogState";

export function ThreadMoveDialogHost() {
  const threadRef = useAtomValue(threadMoveDialogAtom);
  return threadRef === null ? null : (
    <ThreadMoveDialog
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
    />
  );
}

function ThreadMoveDialog({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const navigate = useNavigate();
  const thread = useQuietThreadProjection(threadRef)?.projection.thread;
  const shell = useThreadShell(threadRef);
  const working =
    shell !== null &&
    (threadRuntimeIsActive(shell.runtime) || shell.pendingBackgroundTasks.length > 0);
  const { environments } = useEnvironments();
  const links = useEnvironmentQuery(
    peerLinkEnvironment.list({ environmentId: threadRef.environmentId, input: {} }),
  );
  const destinations = (links.data?.links ?? []).filter(
    (link) => link.access === "full-access" && link.status !== "expired",
  );
  const existing = thread?.move?.direction === "outgoing" ? thread.move : null;
  const [destinationId, setDestinationId] = useState<EnvironmentId | null>(
    existing?.environmentId ?? null,
  );
  const destination =
    destinations.find(
      (link) => link.environmentId === (existing?.environmentId ?? destinationId),
    ) ??
    destinations.find((link) => link.status === "reachable") ??
    destinations[0] ??
    null;
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const catalog = useEnvironmentQuery(
    destination?.status === "reachable" && existing === null
      ? threadMove.models({
          environmentId: threadRef.environmentId,
          input: { destinationEnvironmentId: destination.environmentId },
        })
      : null,
  );
  const models = catalog.data ?? [];
  const modelSelection =
    existing?.modelSelection ??
    selection ??
    models.find(
      (option) =>
        option.selection.instanceId === thread?.modelSelection.instanceId &&
        option.selection.model === thread.modelSelection.model,
    )?.selection ??
    models[0]?.selection;
  const [resumeAtReset, setResumeAtReset] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ThreadMoveResult | null>(null);
  const move = useAtomCommand(threadMove.move, { reportFailure: false });
  const cancel = useAtomCommand(threadMove.cancel, { reportFailure: false });
  const allowed = useAtomValue(threadMove.move.permissionAtom(threadRef.environmentId));
  const canCancel = useAtomValue(threadMove.cancel.permissionAtom(threadRef.environmentId));
  const sourceLabel =
    environments.find((environment) => environment.environmentId === threadRef.environmentId)
      ?.label ?? "This machine";
  const complete = result !== null || existing?.phase === "complete";
  const destinationLabel = result?.label ?? existing?.label ?? destination?.label ?? "Destination";
  const resetAt = existing?.resetAt ?? thread?.limitRecovery?.resetAt ?? null;
  const willResume = existing?.resumeAtReset ?? resumeAtReset;
  const close = () => appAtomRegistry.set(threadMoveDialogAtom, null);

  const submit = async () => {
    const target = existing?.environmentId ?? destination?.environmentId;
    if (target === undefined || modelSelection === undefined || pending) return;
    setPending(true);
    setError(null);
    const outcome = await move({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        destinationEnvironmentId: target,
        modelSelection,
        resumeAtReset,
      },
    });
    if (outcome._tag === "Success") setResult(outcome.value);
    else {
      const cause = squashAtomCommandFailure(outcome);
      setError(
        cause instanceof Error ? cause.message : "The move did not finish. Retry to continue.",
      );
    }
    setPending(false);
  };

  const cancelMove = async () => {
    setPending(true);
    const outcome = await cancel({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId },
    });
    if (outcome._tag === "Success") close();
    else {
      const cause = squashAtomCommandFailure(outcome);
      setError(cause instanceof Error ? cause.message : "Could not cancel the move.");
    }
    setPending(false);
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) close();
      }}
    >
      <DialogPopup showCloseButton={!pending}>
        <DialogHeader>
          <DialogTitle>{complete ? "Thread moved" : "Move to another machine"}</DialogTitle>
          <DialogDescription>
            {complete
              ? `Everything is saved on ${destinationLabel}. ${sourceLabel} can go offline now.`
              : "Continue this conversation on another machine with your work right where you left it."}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {complete ? (
            <div className="flex flex-col gap-4">
              <div className="flex items-center gap-3 rounded-lg border border-border bg-muted/40 p-4">
                <CheckCircle2Icon className="size-6 shrink-0 text-success" aria-hidden />
                <div>
                  <p className="font-medium text-sm">Ready on {destinationLabel}</p>
                  <p className="text-muted-foreground text-xs">
                    Conversation and separate checkout transferred.
                  </p>
                </div>
              </div>
              <p className="text-muted-foreground text-sm">
                {willResume && resetAt
                  ? "Auto-resume is scheduled for the limit reset. Keep the destination online."
                  : "Open the thread on the destination to continue."}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-5">
              <p className="truncate font-medium text-sm">{thread?.title ?? "Loading thread…"}</p>
              <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate text-sm">{sourceLabel}</span>
                <ArrowRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <Select
                    value={existing?.environmentId ?? destination?.environmentId ?? null}
                    disabled={pending || existing !== null}
                    onValueChange={(value) => {
                      setDestinationId(value);
                      setSelection(null);
                    }}
                    items={destinations.map((link) => ({
                      value: link.environmentId,
                      label: link.label,
                    }))}
                  >
                    <SelectTrigger aria-label="Destination machine">
                      <SelectValue placeholder={links.isPending ? "Loading…" : "Choose machine"} />
                    </SelectTrigger>
                    <SelectPopup>
                      {destinations.map((link) => (
                        <SelectItem
                          key={link.environmentId}
                          value={link.environmentId}
                          disabled={link.status !== "reachable"}
                        >
                          {link.label}
                          {link.status !== "reachable" ? " · Offline" : ""}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              </div>
              {destinations.length === 0 && !links.isPending ? (
                <p className="text-muted-foreground text-sm">
                  Link a machine with full access in{" "}
                  <Link
                    to="/settings/connections"
                    onClick={close}
                    className="text-foreground underline"
                  >
                    Connections
                  </Link>{" "}
                  to move threads.
                </p>
              ) : null}
              {modelSelection ? (
                <div className="flex flex-col gap-2">
                  <Label>Continue with</Label>
                  <Select
                    value={JSON.stringify({
                      instanceId: modelSelection.instanceId,
                      model: modelSelection.model,
                    })}
                    disabled={pending || existing !== null || models.length === 0}
                    onValueChange={(value) => {
                      const option = models.find(
                        (option) => JSON.stringify(option.selection) === value,
                      );
                      if (option) setSelection(option.selection);
                    }}
                  >
                    <SelectTrigger aria-label="Destination provider and model">
                      <SelectValue>
                        {models.find(
                          (option) =>
                            option.selection.instanceId === modelSelection.instanceId &&
                            option.selection.model === modelSelection.model,
                        )?.label ?? `${modelSelection.instanceId} · ${modelSelection.model}`}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {models.map((option) => (
                        <SelectItem
                          key={JSON.stringify(option.selection)}
                          value={JSON.stringify(option.selection)}
                        >
                          {option.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                </div>
              ) : null}
              <ul className="flex flex-col gap-3 rounded-lg border border-border bg-muted/30 p-4 text-sm">
                <li className="flex items-start gap-3">
                  <MessageSquareIcon
                    aria-hidden
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  />
                  <div>
                    Portable conversation handoff
                    <p className="text-muted-foreground text-xs">
                      Your history follows you across providers.
                    </p>
                  </div>
                </li>
                <li className="flex items-start gap-3">
                  <FolderGit2Icon
                    aria-hidden
                    className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                  />
                  <div>
                    Separate checkout on the destination
                    <p className="text-muted-foreground text-xs">
                      Includes local commits, staged and unstaged changes, and untracked files.
                      Ignored files stay here.
                    </p>
                  </div>
                </li>
                <li className="flex items-center gap-3">
                  <GitBranchIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{thread?.branch ?? "Current Git revision"}</span>
                </li>
              </ul>
              {catalog.isPending ? (
                <p className="text-muted-foreground text-sm">Loading destination models…</p>
              ) : catalog.error ? (
                <p role="alert" className="text-destructive-foreground text-sm">
                  Could not load destination models. Check the connection and try again.
                </p>
              ) : destination?.status === "reachable" && models.length === 0 && !existing ? (
                <p className="text-muted-foreground text-sm">
                  Enable and sign in to a provider on the destination first.
                </p>
              ) : null}
              {resetAt ? (
                <label className="flex cursor-pointer items-start gap-3">
                  <Checkbox
                    checked={willResume}
                    disabled={pending || existing !== null}
                    onCheckedChange={setResumeAtReset}
                  />
                  <span className="text-sm">
                    Resume when limits reset
                    <span className="mt-1 block text-muted-foreground text-xs">
                      The destination must stay online and signed in to the selected provider.
                    </span>
                  </span>
                </label>
              ) : null}
              <p aria-live="polite" className="text-muted-foreground text-xs">
                {pending
                  ? "Transferring conversation and workspace. Keep both machines online until the move finishes."
                  : existing?.phase === "committed"
                    ? "The source is paused. Retry to finish activating the destination."
                    : existing
                      ? "The source is paused while this move is unfinished. Retry, or cancel to continue here."
                      : working
                        ? `The current turn stops here and continues on ${destinationLabel}. Wait for confirmation before taking this machine offline.`
                        : "This thread is archived here once the move finishes. Wait for confirmation before taking this machine offline."}
              </p>
              {error ? (
                <p role="alert" className="text-destructive-foreground text-sm">
                  {error}
                </p>
              ) : null}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          {complete ? (
            <>
              <Button variant="outline" onClick={close}>
                Done
              </Button>
              {environments.some(
                (environment) =>
                  environment.environmentId === (result?.environmentId ?? existing?.environmentId),
              ) ? (
                <Button
                  onClick={() => {
                    const target =
                      result ??
                      (existing
                        ? { environmentId: existing.environmentId, threadId: existing.threadId }
                        : null);
                    if (target) {
                      void navigate({
                        to: "/$environmentId/$threadId",
                        params: scopeThreadRef(target.environmentId, target.threadId),
                      });
                      close();
                    }
                  }}
                >
                  Open on {destinationLabel}
                </Button>
              ) : null}
            </>
          ) : (
            <>
              <Button
                variant="outline"
                disabled={pending || (existing !== null && !canCancel)}
                onClick={() => {
                  if (existing?.phase === "preparing") void cancelMove();
                  else close();
                }}
              >
                {existing?.phase === "preparing" ? "Cancel move" : "Close"}
              </Button>
              <Button
                disabled={
                  !allowed ||
                  pending ||
                  thread === undefined ||
                  modelSelection === undefined ||
                  (!existing && destination?.status !== "reachable")
                }
                onClick={() => void submit()}
              >
                {pending ? "Moving…" : existing ? "Retry move" : "Move thread"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
