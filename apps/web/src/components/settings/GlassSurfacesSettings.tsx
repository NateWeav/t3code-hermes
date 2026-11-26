import type { CSSProperties } from "react";
import { msg, useGT, useMessages } from "gt-react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  GLASS_SURFACE_OPAQUE,
  type GlassSurfaces,
  MAX_GLASS_SURFACE_BLUR,
  MIN_GLASS_SURFACE_BLUR,
} from "@t3tools/contracts/settings";
import * as Equal from "effect/Equal";
import { GLASS_SURFACE_KEYS } from "../../glassSurfaces";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

type GlassSurfaceKey = (typeof GLASS_SURFACE_KEYS)[number];

const SURFACE_LABELS: Record<GlassSurfaceKey, string> = {
  sidebar: msg("Sidebar"),
  chatHeader: msg("Chat header"),
  chatArea: msg("Chat area"),
  composer: msg("Composer"),
  threadDetails: msg("Thread details"),
  menus: msg("Menus and popovers"),
  floatingControls: msg("Floating buttons and banners"),
  dialogs: msg("Dialogs"),
};

function sliderStyle(value: number, min: number, max: number): CSSProperties {
  const ratio = (value - min) / (max - min);
  return {
    "--settings-slider-progress": `${ratio * 100}%`,
    "--settings-slider-fill-offset": `${0.5 - ratio}rem`,
  } as CSSProperties;
}

function SliderControl(props: {
  readonly id: string;
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly display: string;
  readonly onChange: (value: number) => void;
}) {
  return (
    <div className="flex w-full items-center gap-3 sm:w-52">
      <output
        className="min-w-14 rounded-md bg-muted px-2 py-1 text-center font-mono text-xs font-medium tabular-nums text-foreground"
        htmlFor={props.id}
      >
        {props.display}
      </output>
      <input
        aria-label={props.label}
        className="settings-slider min-w-0 flex-1"
        id={props.id}
        max={props.max}
        min={props.min}
        onChange={(event) => {
          const value = Number(event.currentTarget.value);
          if (Number.isInteger(value) && value >= props.min && value <= props.max) {
            props.onChange(value);
          }
        }}
        step={5}
        style={sliderStyle(props.value, props.min, props.max)}
        type="range"
        value={props.value}
      />
    </div>
  );
}

/** Fork: translucent surfaces over the theme background image. */
export function GlassSurfacesSection(props: {
  readonly glassSurfaces: GlassSurfaces;
  readonly onChange: (glassSurfaces: GlassSurfaces) => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const searchableSetting = useSearchableSetting();
  const glass = props.glassSurfaces;
  const defaults = DEFAULT_UNIFIED_SETTINGS.glassSurfaces;
  const update = (patch: Partial<GlassSurfaces>) => props.onChange({ ...glass, ...patch });

  return (
    <SettingsSection id="glass-surfaces" title={gt("Glass surfaces")}>
      <SettingsRow
        {...searchableSetting("glass-surfaces")}
        description={gt(
          "Make panels translucent and blur the theme's background image behind them. Set a surface to 100% to keep it solid.",
        )}
        resetAction={
          Equal.equals(glass, defaults) ? null : (
            <SettingResetButton
              ariaLabel={gt("Reset glass surfaces to default")}
              onClick={() => props.onChange(defaults)}
            />
          )
        }
        control={
          <Switch
            checked={glass.enabled}
            onCheckedChange={(checked) => update({ enabled: Boolean(checked) })}
            aria-label={gt("Glass surfaces")}
          />
        }
      />
      {glass.enabled ? (
        <>
          <SettingsRow
            title={gt("Blur")}
            description={gt("How strongly each glass surface blurs what is behind it.")}
            control={
              <SliderControl
                id="glass-surface-blur"
                label={gt("Glass blur")}
                value={glass.blur}
                min={MIN_GLASS_SURFACE_BLUR}
                max={MAX_GLASS_SURFACE_BLUR}
                display={`${glass.blur}px`}
                onChange={(blur) => update({ blur })}
              />
            }
          />
          {GLASS_SURFACE_KEYS.map((key) => (
            <SettingsRow
              key={key}
              title={m(SURFACE_LABELS[key])}
              control={
                <SliderControl
                  id={`glass-surface-${key}`}
                  label={gt("{surface} opacity", { surface: m(SURFACE_LABELS[key]) })}
                  value={glass[key]}
                  min={0}
                  max={GLASS_SURFACE_OPAQUE}
                  display={
                    glass[key] === GLASS_SURFACE_OPAQUE
                      ? gt("Solid", { $context: "glass surface fully opaque" })
                      : `${glass[key]}%`
                  }
                  onChange={(value) => update({ [key]: value })}
                />
              }
            />
          ))}
        </>
      ) : null}
    </SettingsSection>
  );
}
