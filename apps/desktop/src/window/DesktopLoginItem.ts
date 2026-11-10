import type { ClientSettings } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import { HIDDEN_LAUNCH_ARG } from "../app/DesktopState.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";

/** A hidden start needs the tray to come back from, so the login item follows both switches. */
const wantsLoginItem = (settings: ClientSettings) =>
  settings.keepRunningInTray && settings.launchAtLogin;

export class DesktopLoginItem extends Context.Service<
  DesktopLoginItem,
  {
    readonly initialize: Effect.Effect<void>;
    readonly configure: (settings: ClientSettings) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/DesktopLoginItem") {}

const { logWarning } = makeComponentLogger("desktop-login-item");

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const clientSettings = yield* DesktopClientSettings.DesktopClientSettings;
  // Electron has no Linux login items, and an unpackaged build would register electron.exe.
  const supported = environment.platform === "win32" && environment.isPackaged;

  const apply = (openAtLogin: boolean) =>
    Effect.try(() =>
      Electron.app.setLoginItemSettings({
        openAtLogin,
        path: process.execPath,
        // Windows matches the Run entry by path and args, so removal must pass the same args.
        args: [HIDDEN_LAUNCH_ARG],
      }),
    ).pipe(Effect.catchCause((cause) => logWarning("failed to update the login item", { cause })));

  return DesktopLoginItem.of({
    // Re-applied each launch so an install that moved the executable re-points the entry.
    initialize: Effect.gen(function* () {
      if (!supported) return;
      const stored = yield* clientSettings.get;
      if (Option.isSome(stored) && wantsLoginItem(stored.value)) yield* apply(true);
    }).pipe(
      Effect.catch((error) =>
        logWarning("could not read client settings for the login item", {
          message: error.message,
        }),
      ),
      Effect.withSpan("desktop.loginItem.initialize"),
    ),
    configure: Effect.fn("desktop.loginItem.configure")(function* (settings) {
      if (!supported) return;
      yield* apply(wantsLoginItem(settings));
    }),
  });
});

export const layer = Layer.effect(DesktopLoginItem, make);
