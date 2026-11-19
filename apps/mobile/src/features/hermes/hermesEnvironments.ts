import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo } from "react";

import { useServerConfigs } from "../../state/entities";

const HERMES_DRIVER = "hermes";

export interface HermesEnvironmentOption {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export function useHermesEnvironmentOptions(): ReadonlyArray<HermesEnvironmentOption> {
  const configs = useServerConfigs();
  return useMemo(() => {
    const options: HermesEnvironmentOption[] = [];
    for (const [environmentId, config] of configs) {
      // Hermes is built in, so every environment lists it; only enabled ones count.
      if (
        config.providers.some((provider) => provider.driver === HERMES_DRIVER && provider.enabled)
      ) {
        options.push({ environmentId, label: config.environment.label });
      }
    }
    return options.sort((left, right) => left.label.localeCompare(right.label));
  }, [configs]);
}

export function useHermesProviderPresent(): boolean {
  return useHermesEnvironmentOptions().length > 0;
}
