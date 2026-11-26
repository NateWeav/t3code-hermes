import { useEffectEvent, useRef } from "react";
import { ImageIcon, XIcon } from "lucide-react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_WALLPAPER_BACKDROP_TINT,
  MIN_WALLPAPER_BACKDROP_TINT,
} from "@t3tools/contracts/settings";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { useWallpaperBackdropState, useWindowManagement } from "../../WallpaperBackdrop";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/**
 * Fork: desktop wallpaper backdrop. The image stays in this browser's local
 * storage, so each browser (and the desktop app) sets its own copy.
 */
export function WallpaperSettingsSection({
  enabled,
  tint,
  updateSettings,
}: {
  enabled: boolean;
  tint: number;
  updateSettings: (patch: { wallpaperBackdropEnabled?: boolean; wallpaperBackdropTint?: number }) => void;
}) {
  const wallpaper = useWallpaperBackdropState();
  const management = useWindowManagement();
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const chooseWallpaper = useEffectEvent(() => {
    fileInputRef.current?.click();
  });
  const handleFileChange = useEffectEvent((event: { currentTarget: HTMLInputElement }) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    void wallpaper.chooseWallpaper(file);
  });

  const tintRatio =
    (tint - MIN_WALLPAPER_BACKDROP_TINT) / (MAX_WALLPAPER_BACKDROP_TINT - MIN_WALLPAPER_BACKDROP_TINT);
  const tintSliderStyle = {
    "--settings-slider-progress": `${tintRatio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - tintRatio}rem`,
  } as React.CSSProperties;

  return (
    <SettingsSection id="wallpaper" title="Wallpaper">
      <SettingsRow
        {...searchableSetting("wallpaper-backdrop")}
        description="Show your desktop wallpaper behind see-through panels, like a transparent Discord theme. Works best with the window maximized; the image stays in this browser."
        resetAction={
          enabled !== DEFAULT_UNIFIED_SETTINGS.wallpaperBackdropEnabled ||
          tint !== DEFAULT_UNIFIED_SETTINGS.wallpaperBackdropTint ? (
            <SettingResetButton
              label="wallpaper backdrop"
              onClick={() => {
                updateSettings({
                  wallpaperBackdropEnabled: DEFAULT_UNIFIED_SETTINGS.wallpaperBackdropEnabled,
                  wallpaperBackdropTint: DEFAULT_UNIFIED_SETTINGS.wallpaperBackdropTint,
                });
              }}
            />
          ) : null
        }
        control={
          <Switch
            checked={enabled}
            onCheckedChange={(checked) => updateSettings({ wallpaperBackdropEnabled: Boolean(checked) })}
            aria-label="Wallpaper backdrop"
          />
        }
      />
      <SettingsRow
        {...searchableSetting("wallpaper-image")}
        description={
          wallpaper.stored === null
            ? "Choose the image file you use as your Windows wallpaper, with the fit set to Span."
            : management.status === "ready"
              ? "Aligned to your monitor layout. The browser asks once for window management to track which screen the window is on."
              : "Click anywhere once and allow window management so the wallpaper can follow the window across monitors."
        }
        status={
          wallpaper.error !== null ? (
            <span className="text-xs text-destructive-foreground">{wallpaper.error}</span>
          ) : null
        }
        control={
          <div className="flex w-full items-center justify-end gap-2">
            <input
              ref={fileInputRef}
              accept="image/*"
              className="sr-only"
              onChange={handleFileChange}
              type="file"
            />
            <Button
              disabled={wallpaper.status === "reading"}
              onClick={chooseWallpaper}
              size="sm"
              variant="outline"
            >
              <ImageIcon />
              {wallpaper.stored === null
                ? wallpaper.status === "reading"
                  ? "Reading…"
                  : "Choose image"
                : wallpaper.status === "reading"
                  ? "Reading…"
                  : "Replace"}
            </Button>
            {wallpaper.stored !== null ? (
              <Button
                aria-label="Remove wallpaper image"
                onClick={wallpaper.clearWallpaper}
                size="icon-sm"
                variant="ghost-muted"
              >
                <XIcon />
              </Button>
            ) : null}
          </div>
        }
      />
      {enabled ? (
        <SettingsRow
          {...searchableSetting("wallpaper-tint")}
          description="Darken the panels over the wallpaper so text stays readable."
          control={
            <div className="flex w-full items-center gap-3 sm:w-52">
              <output
                className="min-w-12 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
                htmlFor="wallpaper-tint"
              >
                {tint}%
              </output>
              <input
                aria-label="Wallpaper tint"
                className="settings-slider min-w-0 flex-1"
                id="wallpaper-tint"
                max={MAX_WALLPAPER_BACKDROP_TINT}
                min={MIN_WALLPAPER_BACKDROP_TINT}
                onChange={(event) => {
                  const value = Number(event.currentTarget.value);
                  if (
                    Number.isInteger(value) &&
                    value >= MIN_WALLPAPER_BACKDROP_TINT &&
                    value <= MAX_WALLPAPER_BACKDROP_TINT
                  ) {
                    updateSettings({ wallpaperBackdropTint: value });
                  }
                }}
                step={5}
                style={tintSliderStyle}
                type="range"
                value={tint}
              />
            </div>
          }
        />
      ) : null}
    </SettingsSection>
  );
}
