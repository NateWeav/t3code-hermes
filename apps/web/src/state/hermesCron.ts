import { useAtomValue } from "@effect/atom-react";
import {
  describeHermesCronEmptyState,
  emptyHermesCronView,
  type HermesCronView,
} from "@t3tools/client-runtime/state/hermes-cron";
import { ProviderDriverKind } from "@t3tools/contracts";
import type { EnvironmentId, HermesCronJobId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { deriveProviderInstanceEntries } from "../providerInstances";
import { environmentPresentations } from "./presentation";
import { useEnvironmentQuery } from "./query";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

const HERMES_DRIVER_KIND = ProviderDriverKind.make("hermes");

/**
 * The environment whose Hermes the panel talks to, or `null` when no connected
 * environment has one.
 *
 * Hermes usually lives on exactly one machine — the always-on box — which is
 * frequently not the environment a browser opened first. Resolving across every
 * connected environment (primary first, so a local Hermes still wins) is what
 * keeps the panel reachable from a laptop pointed at a remote host, matching
 * how mobile already picks its environment.
 */
const hermesEnvironmentIdAtom = Atom.make((get): EnvironmentId | null => {
  const primaryId = get(primaryEnvironmentIdAtom);
  const candidates: EnvironmentId[] = [];
  for (const [environmentId] of get(environmentPresentations.presentationsAtom)) {
    candidates.push(environmentId);
  }
  const ordered =
    primaryId === null ? candidates : [primaryId, ...candidates.filter((id) => id !== primaryId)];

  for (const environmentId of ordered) {
    const providers = get(serverEnvironment.configValueAtom(environmentId))?.providers;
    if (
      providers !== undefined &&
      deriveProviderInstanceEntries(providers).some(
        (entry) => entry.driverKind === HERMES_DRIVER_KIND,
      )
    ) {
      return environmentId;
    }
  }
  return null;
}).pipe(Atom.withLabel("web-hermes-environment-id"));

/**
 * Whether any connected environment has a Hermes instance at all.
 *
 * Drives the sidebar entry point: with no Hermes there is nothing to schedule,
 * so the button never appears rather than leading to an explanatory page.
 */
const hermesProviderPresentAtom = Atom.make(
  (get): boolean => get(hermesEnvironmentIdAtom) !== null,
).pipe(Atom.withLabel("web-hermes-provider-present"));

export function useHermesProviderPresent(): boolean {
  return useAtomValue(hermesProviderPresentAtom);
}

export function useHermesEnvironmentId(): EnvironmentId | null {
  return useAtomValue(hermesEnvironmentIdAtom);
}

export interface HermesCronState {
  readonly view: HermesCronView;
  readonly environmentId: EnvironmentId | null;
  /** True only before the first snapshot lands — never while one is on screen. */
  readonly isPending: boolean;
  readonly error: string | null;
  readonly emptyState: ReturnType<typeof describeHermesCronEmptyState>;
}

export function useHermesCron() {
  const environmentId = useHermesEnvironmentId();
  const query = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.hermesCron({ environmentId, input: {} }),
  );
  const view = query.data ?? emptyHermesCronView;
  const state: HermesCronState = {
    view,
    environmentId,
    // A snapshot already on screen outranks a reconnecting subscription: the
    // list stays readable instead of flashing back to a skeleton.
    isPending: query.isPending && view.snapshot === null,
    error: view.snapshot === null ? query.error : null,
    emptyState: describeHermesCronEmptyState(view.snapshot),
  };

  const setEnabledCommand = useAtomCommand(serverEnvironment.hermesCronSetEnabled);
  const setMutedCommand = useAtomCommand(serverEnvironment.hermesCronSetMuted);

  const setEnabled = useCallback(
    (jobId: HermesCronJobId, enabled: boolean) => {
      if (environmentId === null) return;
      void setEnabledCommand({ environmentId, input: { jobId, enabled } });
    },
    [environmentId, setEnabledCommand],
  );

  const setMuted = useCallback(
    (jobId: HermesCronJobId, muted: boolean) => {
      if (environmentId === null) return;
      void setMutedCommand({ environmentId, input: { jobId, muted } });
    },
    [environmentId, setMutedCommand],
  );

  const jobs = useMemo(() => state.view.snapshot?.jobs ?? [], [state.view.snapshot]);

  return { ...state, jobs, setEnabled, setMuted };
}
