export const BRAND_ASSET_PATHS = {
  developmentIconComposerProject: "assets/hermes/app-icon.icon",
  developmentIosIconPng: "assets/hermes/ios-1024.png",
  developmentUniversalIconPng: "assets/hermes/icon-1024.png",

  productionIconComposerProject: "assets/hermes/app-icon.icon",
  productionIosIconPng: "assets/hermes/ios-1024.png",
  productionMacIconPng: "assets/hermes/macos-1024.png",
  productionLinuxIconPng: "assets/hermes/icon-1024.png",
  productionWindowsIconIco: "assets/hermes/icon.ico",
  productionWebFaviconIco: "assets/hermes/favicon.ico",
  productionWebFavicon16Png: "assets/hermes/favicon-16x16.png",
  productionWebFavicon32Png: "assets/hermes/favicon-32x32.png",
  productionWebAppleTouchIconPng: "assets/hermes/apple-touch-icon.png",
  productionWebIcon192Png: "assets/hermes/icon-192x192.png",
  productionWebIcon512Png: "assets/hermes/icon-512x512.png",

  nightlyIconComposerProject: "assets/hermes/app-icon.icon",
  nightlyIosIconPng: "assets/hermes/ios-1024.png",
  nightlyMacIconPng: "assets/hermes/macos-1024.png",
  nightlyLinuxIconPng: "assets/hermes/icon-1024.png",
  nightlyWindowsIconIco: "assets/hermes/icon.ico",
  nightlyWebFaviconIco: "assets/hermes/favicon.ico",
  nightlyWebFavicon16Png: "assets/hermes/favicon-16x16.png",
  nightlyWebFavicon32Png: "assets/hermes/favicon-32x32.png",
  nightlyWebAppleTouchIconPng: "assets/hermes/apple-touch-icon.png",
  nightlyWebIcon192Png: "assets/hermes/icon-192x192.png",
  nightlyWebIcon512Png: "assets/hermes/icon-512x512.png",

  developmentDesktopIconPng: "assets/hermes/macos-1024.png",
  developmentWindowsIconIco: "assets/hermes/icon.ico",
  developmentWebFaviconIco: "assets/hermes/favicon.ico",
  developmentWebFavicon16Png: "assets/hermes/favicon-16x16.png",
  developmentWebFavicon32Png: "assets/hermes/favicon-32x32.png",
  developmentWebAppleTouchIconPng: "assets/hermes/apple-touch-icon.png",
  developmentWebIcon192Png: "assets/hermes/icon-192x192.png",
  developmentWebIcon512Png: "assets/hermes/icon-512x512.png",
} as const;

export type WebAssetBrand = "development" | "nightly" | "production";

export const WEB_ASSET_CHANNELS = ["latest", "nightly"] as const;

export type WebAssetChannel = (typeof WEB_ASSET_CHANNELS)[number];

export function resolveWebAssetBrandForChannel(channel: WebAssetChannel): WebAssetBrand {
  return channel === "nightly" ? "nightly" : "production";
}

export interface IconOverride {
  readonly sourceRelativePath: string;
  readonly targetRelativePath: string;
}

const WEB_ICON_TARGET_FILENAMES = {
  faviconIco: "favicon.ico",
  favicon16Png: "favicon-16x16.png",
  favicon32Png: "favicon-32x32.png",
  appleTouchIconPng: "apple-touch-icon.png",
  icon192Png: "icon-192x192.png",
  icon512Png: "icon-512x512.png",
} as const;

const WEB_ICON_SOURCE_PATHS_BY_BRAND = {
  development: {
    faviconIco: BRAND_ASSET_PATHS.developmentWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.developmentWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.developmentWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.developmentWebAppleTouchIconPng,
    icon192Png: BRAND_ASSET_PATHS.developmentWebIcon192Png,
    icon512Png: BRAND_ASSET_PATHS.developmentWebIcon512Png,
  },
  nightly: {
    faviconIco: BRAND_ASSET_PATHS.nightlyWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.nightlyWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.nightlyWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.nightlyWebAppleTouchIconPng,
    icon192Png: BRAND_ASSET_PATHS.nightlyWebIcon192Png,
    icon512Png: BRAND_ASSET_PATHS.nightlyWebIcon512Png,
  },
  production: {
    faviconIco: BRAND_ASSET_PATHS.productionWebFaviconIco,
    favicon16Png: BRAND_ASSET_PATHS.productionWebFavicon16Png,
    favicon32Png: BRAND_ASSET_PATHS.productionWebFavicon32Png,
    appleTouchIconPng: BRAND_ASSET_PATHS.productionWebAppleTouchIconPng,
    icon192Png: BRAND_ASSET_PATHS.productionWebIcon192Png,
    icon512Png: BRAND_ASSET_PATHS.productionWebIcon512Png,
  },
} as const satisfies Record<WebAssetBrand, Record<keyof typeof WEB_ICON_TARGET_FILENAMES, string>>;

export function resolveWebIconOverrides(
  brand: WebAssetBrand,
  targetDirectory: string,
): ReadonlyArray<IconOverride> {
  const sourcePaths = WEB_ICON_SOURCE_PATHS_BY_BRAND[brand];
  return [
    {
      sourceRelativePath: sourcePaths.faviconIco,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.faviconIco}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon16Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon16Png}`,
    },
    {
      sourceRelativePath: sourcePaths.favicon32Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.favicon32Png}`,
    },
    {
      sourceRelativePath: sourcePaths.appleTouchIconPng,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.appleTouchIconPng}`,
    },
    {
      sourceRelativePath: sourcePaths.icon192Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.icon192Png}`,
    },
    {
      sourceRelativePath: sourcePaths.icon512Png,
      targetRelativePath: `${targetDirectory}/${WEB_ICON_TARGET_FILENAMES.icon512Png}`,
    },
  ];
}

export const DEVELOPMENT_ICON_OVERRIDES = resolveWebIconOverrides("development", "dist/client");

export const DEVELOPMENT_PUBLIC_ICON_OVERRIDES = resolveWebIconOverrides(
  "development",
  "apps/web/public",
);
