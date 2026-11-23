import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { afterEach, expect, it, vi } from "vite-plus/test";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({
    APP_VARIANT: process.env.APP_VARIANT,
    T3HERMES_EAS_PROJECT_ID: process.env.T3HERMES_EAS_PROJECT_ID,
  }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, or production.",
  );
});

it.each([
  [undefined, "com.nateweav.t3hermes"],
  ["development", "com.nateweav.t3hermes.dev"],
  ["preview", "com.nateweav.t3hermes.preview"],
  ["production", "com.nateweav.t3hermes"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  // Copied thread links open this app only while app.t3.codes lists it.
  // Hermes fork: app.t3.codes is served by upstream, so its apple-app-site-association and
  // assetlinks files list upstream's app IDs, not this fork's; only the app side is checked here.
  const host = new URL(DEFAULT_HOSTED_APP_URL).host;
  expect(config.ios?.associatedDomains).toContain(`applinks:${host}`);
  expect(config.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host, pathPrefix: "/threads/" },
  ]);
});

it("keeps a project ID for expo-observe and OTA updates off when no EAS project is configured", async () => {
  vi.stubEnv("T3HERMES_EAS_PROJECT_ID", undefined);
  const config = await loadConfig("production");
  expect(config.extra?.eas?.projectId).toBe("00000000-0000-0000-0000-000000000000");
  expect(config.updates?.enabled).toBe(false);
  expect(config.updates?.url).toBeUndefined();
});

it("uses the configured EAS project ID for expo-observe and OTA updates", async () => {
  vi.stubEnv("T3HERMES_EAS_PROJECT_ID", " 11111111-1111-4111-8111-111111111111 ");
  const config = await loadConfig("production");
  expect(config.extra?.eas?.projectId).toBe("11111111-1111-4111-8111-111111111111");
  expect(config.updates?.url).toBe("https://u.expo.dev/11111111-1111-4111-8111-111111111111");
});
