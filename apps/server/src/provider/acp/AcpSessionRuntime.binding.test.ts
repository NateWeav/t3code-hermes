import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

// Answers `initialize`, sending a `session/update` no schema accepts just before the response.
const AGENT = `
const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method !== "initialize") return;
  const write = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
  write({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "s", update: 7 } });
  write({
    jsonrpc: "2.0",
    id: message.id,
    result: { protocolVersion: message.params.protocolVersion, agentCapabilities: {}, authMethods: [] },
  });
});
`;

it.effect("a runtime bound to a session reports undecodable notifications to that session", () =>
  Effect.gen(function* () {
    const cwd = process.cwd();
    const clientInfo = { name: "test", version: "1" };
    const runtime = yield* AcpSessionRuntime.make({
      spawn: { command: process.execPath, args: ["-e", AGENT] },
      cwd,
      clientInfo,
    });
    const undecodable: Array<string> = [];
    yield* runtime.bind!({
      cwd,
      clientInfo,
      onUndecodableNotification: (method) => Effect.sync(() => undecodable.push(method)),
    });
    yield* runtime.initialize();
    assert.deepStrictEqual(undecodable, ["session/update"]);
  }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);
