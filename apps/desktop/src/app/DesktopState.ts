import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";

import type { BackendStartupFailure } from "../backend/DesktopBackendManager.ts";

/** Passed only by the login item, so a manual launch always shows the window. */
export const HIDDEN_LAUNCH_ARG = "--t3-launched-at-login";

/** Startup health of the primary local backend, read by the startup recovery window. */
export type PrimaryBackendStartup =
  | { readonly _tag: "Starting" }
  | { readonly _tag: "Ready" }
  | ({ readonly _tag: "Failing" } & BackendStartupFailure);

export class DesktopState extends Context.Service<
  DesktopState,
  {
    readonly backendReady: Ref.Ref<boolean>;
    readonly quitting: Ref.Ref<boolean>;
    /** True only while keepRunningInTray is on and a tray icon exists. */
    readonly closeToTray: Ref.Ref<boolean>;
    /** Set when the Windows login item launched the app; consumed by the first main window reveal. */
    readonly startHidden: Ref.Ref<boolean>;
    // Set by DesktopUpdates.configure, which runs before the first backend start.
    readonly canInstallUpdates: Ref.Ref<boolean>;
    readonly primaryBackendStartup: SubscriptionRef.SubscriptionRef<PrimaryBackendStartup>;
  }
>()("@t3tools/desktop/app/DesktopState") {}

const make = Effect.all({
  backendReady: Ref.make(false),
  quitting: Ref.make(false),
  closeToTray: Ref.make(false),
  startHidden: Ref.make(process.argv.includes(HIDDEN_LAUNCH_ARG)),
  canInstallUpdates: Ref.make(false),
  primaryBackendStartup: SubscriptionRef.make<PrimaryBackendStartup>({ _tag: "Starting" }),
});

export const layer = Layer.effect(DesktopState, make);
