// @effect-diagnostics nodeBuiltinImport:off - stands up a fake gateway control socket.
/**
 * A stand-in for a running Hermes gateway: `gateway.pid` plus a control
 * socket answering `identify` the way `gateway/control_socket.py` does. It
 * answers with whatever pid `gateway.pid` names, so a fake `hermes gateway
 * restart` that rewrites the file reads as a new gateway.
 */
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";

export async function startFakeGateway(options: {
  readonly home: string;
  readonly pid: number;
  readonly supervisor?: string;
}) {
  const pidFile = NodePath.join(options.home, "gateway.pid");
  NodeFS.writeFileSync(pidFile, JSON.stringify({ pid: options.pid, kind: "hermes-gateway" }));
  let answeredPid: number | null = null;
  const server = NodeNet.createServer((socket) => {
    socket.once("data", () => {
      const recorded = (JSON.parse(NodeFS.readFileSync(pidFile, "utf8")) as { pid: number }).pid;
      socket.end(
        `${JSON.stringify({
          ok: true,
          protocol: 1,
          id: 1,
          result: {
            protocol: 1,
            pid: answeredPid ?? recorded,
            supervisor: options.supervisor ?? "systemd",
          },
        })}\n`,
      );
    });
  });
  const socketPath = NodePath.join(options.home, "gateway.sock");
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  return {
    pidFile,
    /** Answer with this pid whatever `gateway.pid` says; null follows the file again. */
    answerPid: (pid: number | null) => {
      answeredPid = pid;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
