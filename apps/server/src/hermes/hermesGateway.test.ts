// @effect-diagnostics nodeBuiltinImport:off - builds fixture Hermes homes synchronously.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";

import {
  describeRestartOutput,
  latestModifiedMs,
  readRunningHermesGateway,
} from "./hermesGateway.ts";
import { startFakeGateway } from "./hermesGatewayFixtures.ts";

const makeHome = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hgw-"));

describe("hermes gateway", () => {
  it("reads a live gateway and when it started", async () => {
    const home = makeHome();
    const gateway = await startFakeGateway({ home, pid: 4242, supervisor: "launchd" });
    try {
      // 2026-09-30T19:19:03Z, in seconds as utimes takes it.
      const startedAtSeconds = 1_790_795_943;
      NodeFS.utimesSync(gateway.pidFile, startedAtSeconds, startedAtSeconds);
      const running = await readRunningHermesGateway(home);
      assert.deepStrictEqual(running, {
        pid: 4242,
        supervisor: "launchd",
        startedAtMs: startedAtSeconds * 1000,
      });
    } finally {
      await gateway.close();
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("reports no gateway when nothing answers or the pid file is someone else's", async () => {
    const home = makeHome();
    try {
      assert.isNull(await readRunningHermesGateway(home));
      // A socket file a crashed gateway left behind.
      NodeFS.writeFileSync(NodePath.join(home, "gateway.sock"), "");
      assert.isNull(await readRunningHermesGateway(home));
      NodeFS.rmSync(NodePath.join(home, "gateway.sock"));

      const gateway = await startFakeGateway({ home, pid: 4242 });
      try {
        assert.isNotNull(await readRunningHermesGateway(home));
        // gateway.pid names a different process than the one that answered.
        gateway.answerPid(4243);
        assert.isNull(await readRunningHermesGateway(home));
      } finally {
        await gateway.close();
      }
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });

  it("takes the latest change among the files that exist", async () => {
    const root = makeHome();
    try {
      NodeFS.mkdirSync(NodePath.join(root, "gateway"));
      NodeFS.writeFileSync(NodePath.join(root, "gateway", "run.py"), "");
      NodeFS.writeFileSync(NodePath.join(root, "cli.py"), "");
      NodeFS.utimesSync(NodePath.join(root, "gateway", "run.py"), 1_000, 1_000);
      NodeFS.utimesSync(NodePath.join(root, "cli.py"), 2_000, 2_000);
      assert.strictEqual(
        await latestModifiedMs(root, ["gateway/run.py", "cli.py", "missing.py"]),
        2_000_000,
      );
      assert.isNull(await latestModifiedMs(root, ["missing.py"]));
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the last lines of failed restart output, without colour codes", () => {
    assert.strictEqual(
      describeRestartOutput(
        "Stopping...\n\u001b[31m✗ Gateway service restart failed.\u001b[0m\n",
        "",
      ),
      "Stopping... ✗ Gateway service restart failed.",
    );
    assert.isNull(describeRestartOutput("", "\n"));
  });
});
