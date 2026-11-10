import { assert, describe, it } from "@effect/vitest";
import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { beforeEach, vi } from "vite-plus/test";

const setLoginItemSettings = vi.hoisted(() => vi.fn());

vi.mock("electron", () => ({ app: { setLoginItemSettings } }));

import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { HIDDEN_LAUNCH_ARG } from "../app/DesktopState.ts";
import * as DesktopClientSettings from "../settings/DesktopClientSettings.ts";
import * as DesktopLoginItem from "./DesktopLoginItem.ts";

beforeEach(() => {
  setLoginItemSettings.mockReset();
});

const withSwitches = (keepRunningInTray: boolean, launchAtLogin: boolean): ClientSettings => ({
  ...DEFAULT_CLIENT_SETTINGS,
  keepRunningInTray,
  launchAtLogin,
});

function layerTest(input: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly settings?: Option.Option<ClientSettings>;
}) {
  return DesktopLoginItem.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        DesktopEnvironment.layer({
          dirname: "/repo/apps/desktop/dist-electron",
          homeDirectory: "/home/alice",
          platform: input.platform,
          processArch: "x64",
          appVersion: "1.2.3",
          appPath: "/repo",
          isPackaged: input.isPackaged,
          resourcesPath: "/repo/resources",
          runningUnderArm64Translation: false,
        }).pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({})))),
        DesktopClientSettings.layerTest(input.settings ?? Option.none()),
      ),
    ),
  );
}

const openAtLoginCalls = () =>
  setLoginItemSettings.mock.calls.map(([settings]) => {
    assert.deepEqual(settings.args, [HIDDEN_LAUNCH_ARG]);
    return settings.openAtLogin as boolean;
  });

describe("DesktopLoginItem", () => {
  it.effect.each([
    { tray: true, login: true, expected: true },
    { tray: true, login: false, expected: false },
    // A hidden start without a tray would leave no way back to the window.
    { tray: false, login: true, expected: false },
  ])(
    "configure registers only with both switches on (tray=$tray login=$login)",
    ({ tray, login, expected }) =>
      Effect.gen(function* () {
        const loginItem = yield* DesktopLoginItem.DesktopLoginItem;
        yield* loginItem.configure(withSwitches(tray, login));
        assert.deepEqual(openAtLoginCalls(), [expected]);
      }).pipe(Effect.provide(layerTest({ platform: "win32", isPackaged: true }))),
  );

  it.effect.each([
    { name: "linux", platform: "linux" as const, isPackaged: true },
    { name: "an unpackaged build", platform: "win32" as const, isPackaged: false },
  ])("$name never touches the login item", ({ platform, isPackaged }) =>
    Effect.gen(function* () {
      const loginItem = yield* DesktopLoginItem.DesktopLoginItem;
      yield* loginItem.initialize;
      yield* loginItem.configure(withSwitches(true, true));
      assert.equal(setLoginItemSettings.mock.calls.length, 0);
    }).pipe(
      Effect.provide(
        layerTest({ platform, isPackaged, settings: Option.some(withSwitches(true, true)) }),
      ),
    ),
  );

  it.effect.each([
    {
      name: "re-registers when both switches are stored on",
      settings: Option.some(withSwitches(true, true)),
      expected: [true],
    },
    {
      name: "leaves the entry alone otherwise",
      settings: Option.some(withSwitches(true, false)),
      expected: [],
    },
    {
      name: "leaves the entry alone without stored settings",
      settings: Option.none<ClientSettings>(),
      expected: [],
    },
  ])("initialize $name", ({ settings, expected }) =>
    Effect.gen(function* () {
      const loginItem = yield* DesktopLoginItem.DesktopLoginItem;
      yield* loginItem.initialize;
      assert.deepEqual(openAtLoginCalls(), expected);
    }).pipe(Effect.provide(layerTest({ platform: "win32", isPackaged: true, settings }))),
  );

  it.effect("a failing native call is logged, not raised", () =>
    Effect.gen(function* () {
      setLoginItemSettings.mockImplementation(() => {
        throw new Error("registry denied");
      });
      const loginItem = yield* DesktopLoginItem.DesktopLoginItem;
      yield* loginItem.configure(withSwitches(true, true));
      assert.equal(setLoginItemSettings.mock.calls.length, 1);
    }).pipe(Effect.provide(layerTest({ platform: "win32", isPackaged: true }))),
  );
});
