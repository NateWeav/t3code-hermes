import {
  DEFAULT_SERVER_SETTINGS,
  type ServerSettings,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import { describe, expect, it } from "@effect/vitest";

import {
  listUsageLimitSources,
  planUsageLimitSourceAdd,
  planUsageLimitSourceRemoval,
} from "./usageLimitSources.ts";

describe("usage limit sources", () => {
  it.each([
    ["http://proxy.test:8318/hub-a", "http://proxy.test:8318/hub-b"],
    ["localhost:8318", "localhost:9318"],
  ])("retains saved configurations for %s and %s", (firstUrl, secondUrl) => {
    let settings: ServerSettings = DEFAULT_SERVER_SETTINGS;
    const sources = [
      [firstUrl, "First hub", "first-key"],
      [secondUrl, "Second hub", "second-key"],
      [`${secondUrl}/extra`, "Third hub", "third-key"],
    ] as const;
    for (const [url, label, managementKey] of sources) {
      const [write] = planUsageLimitSourceAdd(
        [{ environmentId: "local", label: "Local", sources: settings.usageLimitSources }],
        { url, label, managementKey },
      );
      settings = applyServerSettingsPatch(settings, write!.patch);
    }
    expect(Object.values(settings.usageLimitSources)).toEqual(
      sources.map(([url, label, managementKey]) => ({
        kind: "cliproxy",
        url,
        label,
        managementKey,
        enabled: true,
      })),
    );
  });

  it("keeps one entry per hub on each environment, whatever id it was saved under", () => {
    const sandbox = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      usageLimitSources: {
        [UsageLimitSourceId.make("cliproxy-10.0.0.7-8317")]: {
          kind: "cliproxy",
          url: "http://10.0.0.7:8317/",
          managementKey: "old-key",
          enabled: true,
        },
      },
    });
    let environments = [
      { environmentId: "sandbox", label: "Sandbox", settings: sandbox },
      { environmentId: "laptop", label: "Laptop", settings: DEFAULT_SERVER_SETTINGS },
    ];
    const targets = () =>
      environments.map(({ environmentId, label, settings }) => ({
        environmentId,
        label,
        sources: settings.usageLimitSources,
      }));
    const apply = (writes: ReturnType<typeof planUsageLimitSourceAdd<string>>) => {
      environments = environments.map((environment) => {
        const write = writes.find((entry) => entry.environmentId === environment.environmentId);
        return write === undefined
          ? environment
          : {
              ...environment,
              settings: applyServerSettingsPatch(environment.settings, write.patch),
            };
      });
    };

    expect(listUsageLimitSources(targets())).toEqual([
      {
        url: "http://10.0.0.7:8317/",
        label: "http://10.0.0.7:8317/",
        enabled: true,
        missingFrom: [targets()[1]],
      },
    ]);

    apply(
      planUsageLimitSourceAdd(targets(), {
        url: "http://10.0.0.7:8317",
        managementKey: "new-key",
        label: "Hub",
      }),
    );
    for (const { settings } of environments) {
      expect(Object.values(settings.usageLimitSources)).toEqual([
        {
          kind: "cliproxy",
          url: "http://10.0.0.7:8317",
          managementKey: "new-key",
          label: "Hub",
          enabled: true,
        },
      ]);
    }
    expect(listUsageLimitSources(targets())[0]?.missingFrom).toEqual([]);

    apply(planUsageLimitSourceRemoval(targets(), "http://10.0.0.7:8317/"));
    expect(environments.map(({ settings }) => settings.usageLimitSources)).toEqual([{}, {}]);
  });
});
