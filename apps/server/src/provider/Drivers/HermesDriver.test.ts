import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { HttpClient } from "effect/unstable/http";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import * as IdAllocator from "../../orchestration-v2/IdAllocator.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { HermesDriver } from "./HermesDriver.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-hermes-driver-update-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(IdAllocator.layer),
  Layer.provideMerge(ServerSettingsService.layerTest()),
  Layer.provideMerge(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      shouldRunScopeWork: () => Effect.succeed(false),
    }),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Disabled Hermes must not make an HTTP request")),
    ),
  ),
);

const noSpawner = ChildProcessSpawner.make(() =>
  Effect.die("Disabled Hermes must not spawn a process"),
);

// The `#!/bin/sh` stub and symlinked launcher below are POSIX-only.
const windowsHost = HostProcessPlatform.defaultValue() === "win32";

/** Lay out `<root>/venv/bin/hermes` with a `~/.local/bin`-style launcher symlink, like the installer. */
const makeHermesInstall = Effect.fn("makeHermesInstall")(function* (input: {
  readonly gitCheckout: boolean;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-hermes-driver-" });
  const checkoutRoot = path.join(tempDir, "hermes-agent");
  const venvBinary = path.join(checkoutRoot, "venv", "bin", "hermes");
  const launcher = path.join(tempDir, "bin", "hermes");
  yield* fs.makeDirectory(path.dirname(venvBinary), { recursive: true });
  yield* fs.makeDirectory(path.dirname(launcher), { recursive: true });
  yield* fs.writeFileString(venvBinary, "#!/bin/sh\n");
  yield* fs.chmod(venvBinary, 0o755);
  yield* fs.symlink(venvBinary, launcher);
  if (input.gitCheckout) {
    yield* fs.makeDirectory(path.join(checkoutRoot, ".git"));
  }
  return { tempDir, launcher };
});

it.layer(testLayer)("HermesDriver", (it) => {
  it.effect.skipIf(windowsHost)("updates a git checkout through `hermes update`", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const { tempDir, launcher } = yield* makeHermesInstall({ gitCheckout: true });
      const hermesHome = path.join(tempDir, "hermes-home");

      const instance = yield* HermesDriver.create({
        instanceId: ProviderInstanceId.make("hermes-update"),
        displayName: "Hermes test",
        enabled: false,
        environment: [{ name: "HERMES_HOME", value: hermesHome, sensitive: false }],
        config: { ...HermesDriver.defaultConfig(), binaryPath: launcher },
      });

      const capabilities = yield* instance.snapshot.resolveMaintenance();
      expect(capabilities.githubReleaseRepository).toBe("NousResearch/hermes-agent");
      expect(capabilities.update).toMatchObject({
        executable: launcher,
        args: ["update", "--yes"],
        lockKey: "hermes",
      });
      // `hermes update` migrates the config under HERMES_HOME, so it must target this instance's home.
      expect(capabilities.update?.env?.HERMES_HOME).toBe(hermesHome);
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      Effect.scoped,
    ),
  );

  it.effect.skipIf(windowsHost)("stays manual-only for an install that is not a git checkout", () =>
    Effect.gen(function* () {
      const { launcher } = yield* makeHermesInstall({ gitCheckout: false });
      const instance = yield* HermesDriver.create({
        instanceId: ProviderInstanceId.make("hermes-packaged"),
        displayName: "Hermes test",
        enabled: false,
        environment: [],
        config: { ...HermesDriver.defaultConfig(), binaryPath: launcher },
      });

      const capabilities = yield* instance.snapshot.resolveMaintenance();
      expect(capabilities.update).toBeNull();
      // Still tracks releases so the settings card can say an update exists.
      expect(capabilities.githubReleaseRepository).toBe("NousResearch/hermes-agent");
    }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, noSpawner),
      Effect.scoped,
    ),
  );
});
