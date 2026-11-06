import {
  type ServerSettingsPatch,
  type SettingsSecretValue,
  type UsageLimitSourceConfig,
  UsageLimitSourceId,
} from "@t3tools/contracts";

type Sources = Readonly<Record<string, UsageLimitSourceConfig>>;

/** A hub belongs to the user, so clients write it to every environment they can. */
export interface UsageLimitSourceTarget<EnvironmentId extends string> {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly sources: Sources;
}

export interface UsageLimitSourceWrite<EnvironmentId extends string> {
  readonly environmentId: EnvironmentId;
  readonly patch: ServerSettingsPatch;
}

// Environments name the same hub differently, so its URL is its identity.
function hubKey(url: string): string {
  const trimmed = url.trim();
  try {
    return new URL(trimmed).href.replace(/\/+$/u, "");
  } catch {
    return trimmed.replace(/\/+$/u, "");
  }
}

/** The entry already saved for `url`, or an id that leaves every other hub in place. */
function usageLimitSourceId(url: string, sources: Sources): UsageLimitSourceId {
  const key = hubKey(url);
  const saved = Object.entries(sources).find(([, source]) => hubKey(source.url) === key);
  if (saved) return UsageLimitSourceId.make(saved[0]);
  let host = url;
  try {
    host = new URL(url).host;
  } catch {}
  const slug = host
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const base = `cliproxy-${slug || "hub"}`;
  let id = base;
  for (let suffix = 2; id in sources; suffix += 1) {
    id = `${base}-${suffix}`;
  }
  return UsageLimitSourceId.make(id);
}

export function planUsageLimitSourceAdd<EnvironmentId extends string>(
  targets: ReadonlyArray<UsageLimitSourceTarget<EnvironmentId>>,
  input: {
    readonly url: string;
    readonly managementKey: SettingsSecretValue;
    readonly label?: string;
  },
): ReadonlyArray<UsageLimitSourceWrite<EnvironmentId>> {
  const label = input.label?.trim();
  const config: UsageLimitSourceConfig = {
    kind: "cliproxy",
    url: input.url.trim(),
    managementKey:
      typeof input.managementKey === "string" ? input.managementKey.trim() : input.managementKey,
    enabled: true,
    ...(label ? { label } : {}),
  };
  return targets.map((target) => ({
    environmentId: target.environmentId,
    patch: { usageLimitSources: { [usageLimitSourceId(config.url, target.sources)]: config } },
  }));
}

export function planUsageLimitSourceRemoval<EnvironmentId extends string>(
  targets: ReadonlyArray<UsageLimitSourceTarget<EnvironmentId>>,
  url: string,
): ReadonlyArray<UsageLimitSourceWrite<EnvironmentId>> {
  const key = hubKey(url);
  return targets.flatMap((target) => {
    const removed = Object.entries(target.sources).flatMap(([id, source]) =>
      hubKey(source.url) === key ? [[UsageLimitSourceId.make(id), null] as const] : [],
    );
    return removed.length === 0
      ? []
      : [
          {
            environmentId: target.environmentId,
            patch: { usageLimitSources: Object.fromEntries(removed) },
          },
        ];
  });
}

interface UsageLimitSourceListing<EnvironmentId extends string> {
  readonly url: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly missingFrom: ReadonlyArray<UsageLimitSourceTarget<EnvironmentId>>;
}

/** One row per hub across environments, with the environments that lack it. */
export function listUsageLimitSources<EnvironmentId extends string>(
  targets: ReadonlyArray<UsageLimitSourceTarget<EnvironmentId>>,
): ReadonlyArray<UsageLimitSourceListing<EnvironmentId>> {
  const hubs = new Map<
    string,
    { url: string; label: string | undefined; enabled: boolean; present: Set<EnvironmentId> }
  >();
  for (const target of targets) {
    for (const source of Object.values(target.sources)) {
      const key = hubKey(source.url);
      const hub = hubs.get(key) ?? {
        url: source.url,
        label: undefined,
        enabled: false,
        present: new Set(),
      };
      hub.label ??= source.label?.trim() || undefined;
      hub.enabled ||= source.enabled;
      hub.present.add(target.environmentId);
      hubs.set(key, hub);
    }
  }
  return Array.from(hubs.values(), (hub) => ({
    url: hub.url,
    label: hub.label ?? hub.url,
    enabled: hub.enabled,
    missingFrom: targets.filter((target) => !hub.present.has(target.environmentId)),
  }));
}
