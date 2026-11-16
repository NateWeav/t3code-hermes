import { ThreadMoveError } from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ThreadMoveService from "./ThreadMoveService.ts";
import { MoveHeader, MoveId, MOVE_ROUTE } from "./protocol.ts";

const decodeHeader = Schema.decodeUnknownEffect(MoveHeader);
const isMoveId = Schema.is(MoveId);

// Handlers run in the router's request context, so the service is captured when the route is built.
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const moves = yield* Effect.serviceOption(ThreadMoveService.ThreadMoveService);
    return HttpRouter.add(
      "*",
      `${MOVE_ROUTE}/*`,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const auth = yield* EnvironmentAuth.EnvironmentAuth;
        const caller = yield* auth.authenticateMcpClient(request).pipe(Effect.option);
        if (caller._tag === "None") return yield* HttpServerResponse.json({}, { status: 401 });
        if (!caller.value.peerLink || caller.value.access !== "full-access")
          return yield* HttpServerResponse.json({}, { status: 403 });
        const owner = caller.value.sessionId;
        const suffix = request.url.slice(`${MOVE_ROUTE}/`.length).split("?", 1)[0] ?? "";
        if (Option.isNone(moves)) return yield* HttpServerResponse.json({}, { status: 503 });
        const service = moves.value;
        if (suffix === "catalog" && request.method === "POST")
          return yield* service.catalog.pipe(Effect.flatMap(HttpServerResponse.json));
        if (suffix === "capacity" && request.method === "POST")
          return yield* service.capacity.pipe(
            Effect.flatMap(HttpServerResponse.json),
            Effect.catch(() => HttpServerResponse.json({}, { status: 403 })),
          );
        const [id, action, extra] = suffix.split("/");
        if (!isMoveId(id) || !action || extra !== undefined)
          return yield* HttpServerResponse.json({}, { status: 400 });
        return yield* Effect.gen(function* () {
          if (request.method === "PUT") {
            const pull = yield* Stream.toPull(request.stream);
            yield* service.upload(owner, id, action, Stream.fromPull(Effect.succeed(pull)));
            return yield* HttpServerResponse.json({});
          }
          if (request.method !== "POST") return yield* HttpServerResponse.json({}, { status: 405 });
          switch (action) {
            case "begin": {
              const header = yield* request.json.pipe(
                Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(64 * 1024)),
                Effect.flatMap(decodeHeader),
              );
              if (header.id !== id) return yield* new ThreadMoveError({ reason: "unsupported" });
              yield* service.begin(owner, header);
              return yield* HttpServerResponse.json({});
            }
            case "prepare":
              return yield* service
                .prepare(owner, id)
                .pipe(Effect.flatMap(HttpServerResponse.json));
            case "activate":
              return yield* service
                .activate(owner, id)
                .pipe(Effect.flatMap(HttpServerResponse.json));
            case "discard":
              yield* service.discard(owner, id);
              return yield* HttpServerResponse.json({});
            default:
              return yield* HttpServerResponse.json({}, { status: 404 });
          }
        }).pipe(
          Effect.catch(() =>
            HttpServerResponse.json(
              { message: "The move could not be completed." },
              { status: 409 },
            ),
          ),
        );
      }),
    );
  }),
);
