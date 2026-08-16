import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProviderQuotaAccount } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo } from "react";

import { appAtomRegistry } from "./atom-registry";
import { environmentPresentations } from "./presentation";
import { serverEnvironment } from "./server";

export interface EnvironmentQuotaStatus {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly accounts: readonly ProviderQuotaAccount[];
}

const quotaAtom = Atom.make((get): readonly EnvironmentQuotaStatus[] => {
  const presentations = get(environmentPresentations.presentationsAtom);
  return Array.from(presentations, ([environmentId, presentation]) => {
    const result = get(serverEnvironment.providerQuota({ environmentId, input: {} }));
    return {
      environmentId,
      label: presentation.entry.target.label,
      isPending: result.waiting,
      error: result._tag === "Failure" ? "This environment could not report plan limits." : null,
      accounts: Option.getOrNull(AsyncResult.value(result))?.accounts ?? [],
    };
  });
}).pipe(Atom.withLabel("mobile-provider-quota"));

export function useProviderQuota() {
  const environments = useAtomValue(quotaAtom);
  const refresh = useCallback(() => {
    for (const environment of environments) {
      appAtomRegistry.refresh(
        serverEnvironment.providerQuota({ environmentId: environment.environmentId, input: {} }),
      );
    }
  }, [environments]);
  const accounts = useMemo(
    () =>
      environments.flatMap((environment) =>
        environment.accounts.map((account) => ({
          ...account,
          environmentLabel: environment.label,
        })),
      ),
    [environments],
  );
  return {
    accounts,
    environments,
    error: environments.find((environment) => environment.error !== null)?.error ?? null,
    isPending:
      environments.length > 0 && environments.every((environment) => environment.isPending),
    refresh,
  };
}
