import { useAtomValue } from "@effect/atom-react";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ModelSelection, ScopedThreadRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { useState } from "react";
import { ScrollView } from "react-native";

import { Button } from "../../components/ui/Button";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { Menu } from "../../components/ui/Menu";
import { Sheet } from "../../components/ui/Sheet";
import { AppText as Text } from "../../components/ui/AppText";
import { appAtomRegistry } from "../../state/atom-registry";
import { useThreadShell } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { peerLinkEnvironment } from "../../state/peerLinks";
import { useEnvironmentQuery } from "../../state/query";
import { threadMove, threadMoveSheetAtom } from "../../state/threadMove";
import { useEnvironmentThread } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

export function ThreadMoveSheetHost() {
  const threadRef = useAtomValue(threadMoveSheetAtom);
  return threadRef === null ? null : (
    <ThreadMoveSheet
      key={`${threadRef.environmentId}:${threadRef.threadId}`}
      threadRef={threadRef}
    />
  );
}

function ThreadMoveSheet({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const close = () => appAtomRegistry.set(threadMoveSheetAtom, null);
  const detail = useEnvironmentThread(threadRef.environmentId, threadRef.threadId);
  const thread = Option.getOrNull(detail.data)?.thread;
  const existing = thread?.move?.direction === "outgoing" ? thread.move : null;
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
  const [destinationId, setDestinationId] = useState<EnvironmentId | null>(null);
  const destination =
    destinations.find(
      (link) => link.environmentId === (existing?.environmentId ?? destinationId),
    ) ??
    destinations.find((link) => link.status === "reachable") ??
    destinations[0] ??
    null;
  const models = useEnvironmentQuery(
    destination?.status === "reachable" && existing === null
      ? threadMove.models({
          environmentId: threadRef.environmentId,
          input: { destinationEnvironmentId: destination.environmentId },
        })
      : null,
  );
  const [selection, setSelection] = useState<ModelSelection | null>(null);
  const modelSelection =
    existing?.modelSelection ??
    selection ??
    models.data?.find(
      (option) =>
        option.selection.instanceId === thread?.modelSelection.instanceId &&
        option.selection.model === thread.modelSelection.model,
    )?.selection ??
    models.data?.[0]?.selection;
  const [resumeAtReset, setResumeAtReset] = useState(true);
  const [pending, setPending] = useState(false);
  const [movedTo, setMovedTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const move = useAtomCommand(threadMove.move, { reportFailure: false });
  const cancel = useAtomCommand(threadMove.cancel, { reportFailure: false });
  const allowed = useAtomValue(threadMove.move.permissionAtom(threadRef.environmentId));
  const canCancel = useAtomValue(threadMove.cancel.permissionAtom(threadRef.environmentId));
  const sourceLabel =
    environments.find((environment) => environment.environmentId === threadRef.environmentId)
      ?.label ?? "This machine";
  const complete = movedTo !== null || existing?.phase === "complete";
  const destinationLabel = movedTo ?? existing?.label ?? destination?.label ?? "the destination";

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
    if (outcome._tag === "Success") setMovedTo(outcome.value.label);
    else {
      const cause = Cause.squash(outcome.cause);
      setError(cause instanceof Error ? cause.message : "The move could not be completed.");
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
      const cause = Cause.squash(outcome.cause);
      setError(cause instanceof Error ? cause.message : "Could not cancel the move.");
    }
    setPending(false);
  };

  return (
    <Sheet
      title={complete ? "Thread moved" : "Move to another machine"}
      onClose={close}
      dismissDisabled={pending}
    >
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-4 px-5 pb-8 pt-4"
      >
        {complete ? (
          <>
            <Text className="text-base font-t3-medium text-foreground">
              Ready on {destinationLabel}.
            </Text>
            <Text className="text-sm text-foreground-muted">
              The portable conversation and separate checkout are ready there. {sourceLabel} can go
              offline.
            </Text>
            <Button label="Done" onPress={close} fullWidth />
          </>
        ) : (
          <>
            <Text className="text-sm text-foreground-muted">
              Continue this conversation across providers with a separate checkout, including local
              commits and uncommitted changes. Ignored files stay here.
            </Text>
            <Menu
              title="Destination machine"
              actions={destinations.map((candidate) => ({
                id: candidate.environmentId,
                title: `${candidate.label}${candidate.status === "reachable" ? "" : " · Offline"}`,
                attributes: {
                  disabled: pending || existing !== null || candidate.status !== "reachable",
                },
              }))}
              onPressAction={({ nativeEvent }) => {
                const chosen = destinations.find(
                  (candidate) => candidate.environmentId === nativeEvent.event,
                );
                if (chosen) {
                  setDestinationId(chosen.environmentId);
                  setSelection(null);
                }
              }}
            >
              <ListActionRow
                label="Destination machine"
                detail={existing?.label ?? destination?.label ?? "Choose machine"}
                disabled={pending || existing !== null || destinations.length === 0}
                onPress={() => undefined}
              />
            </Menu>
            <Menu
              title="Continue with"
              actions={(models.data ?? []).map((option, index) => ({
                id: String(index),
                title: option.label,
              }))}
              onPressAction={({ nativeEvent }) => {
                const option = models.data?.[Number(nativeEvent.event)];
                if (option) setSelection(option.selection);
              }}
            >
              <ListActionRow
                label="Continue with"
                detail={
                  models.data?.find(
                    (option) =>
                      option.selection.instanceId === modelSelection?.instanceId &&
                      option.selection.model === modelSelection?.model,
                  )?.label ??
                  (existing
                    ? existing.modelSelection.model
                    : models.isPending
                      ? "Loading…"
                      : "No models available")
                }
                disabled={pending || existing !== null || (models.data?.length ?? 0) === 0}
                onPress={() => undefined}
              />
            </Menu>
            {existing?.resetAt || thread?.limitRecovery?.resetAt ? (
              <ListToggleRow
                label="Resume when limits reset"
                description="Keep the destination online and signed in."
                value={existing?.resumeAtReset ?? resumeAtReset}
                disabled={pending || existing !== null}
                onValueChange={setResumeAtReset}
              />
            ) : null}
            {destinations.length === 0 && !links.isPending ? (
              <Text className="text-sm text-foreground-muted">
                Link another full-access machine in Connections first.
              </Text>
            ) : null}
            {error || models.error || links.error ? (
              <Text className="text-sm text-danger-foreground">
                {error ?? models.error ?? links.error}
              </Text>
            ) : null}
            <Text className="text-sm text-foreground-muted">
              {pending
                ? "Transferring conversation and workspace. Keep both machines online."
                : `${working && !existing ? `The current turn stops here and continues on ${destinationLabel}. ` : ""}Wait for confirmation before taking the source offline. If a move fails, retry or cancel to continue here.`}
            </Text>
            <Button
              label={existing ? "Retry move" : "Move thread"}
              onPress={() => void submit()}
              disabled={
                !allowed ||
                pending ||
                (!existing && destination?.status !== "reachable") ||
                modelSelection === undefined
              }
              loading={pending}
              fullWidth
            />
            {existing?.phase === "preparing" ? (
              <Button
                label="Cancel move"
                onPress={() => void cancelMove()}
                disabled={!canCancel || pending}
                fullWidth
              />
            ) : null}
          </>
        )}
      </ScrollView>
    </Sheet>
  );
}
