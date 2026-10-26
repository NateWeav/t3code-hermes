// @effect-diagnostics nodeBuiltinImport:off -- Pure synchronous hashing keeps page matching bounded without a runtime dependency.
import * as NodeCrypto from "node:crypto";
import type { ThreadId } from "@t3tools/contracts";
import type { HtmlRenderReference } from "@t3tools/shared/htmlRender";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import type { McpProviderSessionConfig } from "./mcpSession.ts";

// Other providers may never consume these references.
const MAX_KEPT_HTML_RENDERS = 64;

// Antigravity truncates long HTML arguments to a marked tail of at most 8,000 characters.
const BOUNDED_TEXT_MARKER = "[Earlier output truncated]\n\n";
const KEPT_HTML_END_LENGTH = 8_000;

interface KeptHtmlRender {
  readonly title: string;
  readonly height: number;
  readonly htmlLength: number;
  readonly htmlHash: string;
  readonly htmlEnd: string;
  readonly reference: HtmlRenderReference;
}

const hashHtml = (html: string) => NodeCrypto.createHash("sha256").update(html).digest("hex");

export class McpProviderSessions extends Context.Service<
  McpProviderSessions,
  {
    readonly set: (config: McpProviderSessionConfig) => Effect.Effect<void>;
    readonly read: (threadId: ThreadId) => Effect.Effect<McpProviderSessionConfig | undefined>;
    readonly clear: (threadId: ThreadId) => Effect.Effect<void>;
    readonly recordHtmlRender: (
      threadId: ThreadId,
      input: { readonly html: string; readonly title: string; readonly height: number },
      reference: HtmlRenderReference,
    ) => Effect.Effect<void>;
    /** Keeps the ids clients read from a T3 tool result, for providers that report only a summary. */
    readonly recordToolResult: (
      threadId: ThreadId,
      call: { readonly tool: string; readonly input: unknown },
      output: unknown,
    ) => Effect.Effect<void>;
    // Prefers the call with identical input; otherwise only the tool's sole pending call counts.
    readonly takeToolResult: (
      threadId: ThreadId,
      call: { readonly tool: string; readonly input: unknown },
    ) => Effect.Effect<unknown>;
    // A reported attachment consumes that exact page; otherwise only unique input matches count.
    readonly takeHtmlRender: (
      threadId: ThreadId,
      input: { readonly html?: unknown; readonly title?: unknown; readonly height?: unknown },
      reported?: HtmlRenderReference,
    ) => Effect.Effect<HtmlRenderReference | undefined>;
  }
>()("@t3tools/provider-core/server/McpProviderSessions") {}

const matchingPageIndex = (
  kept: ReadonlyArray<KeptHtmlRender>,
  input: { readonly html?: unknown; readonly title?: unknown; readonly height?: unknown },
): number => {
  const html = input.html;
  if (typeof html !== "string" || html.length === 0) {
    return -1;
  }
  const height =
    typeof input.height === "string" && input.height.trim() !== ""
      ? Number(input.height)
      : input.height;
  const htmlHash = hashHtml(html);
  const tail = html.startsWith(BOUNDED_TEXT_MARKER)
    ? html.slice(BOUNDED_TEXT_MARKER.length)
    : undefined;
  const matches = kept.flatMap((page, index) =>
    page.title === input.title &&
    page.height === height &&
    (page.htmlHash === htmlHash ||
      (tail !== undefined &&
        tail.length > 0 &&
        tail.length < page.htmlLength &&
        page.htmlEnd.endsWith(tail)))
      ? [index]
      : [],
  );
  return matches.length === 1 ? matches[0]! : -1;
};

interface KeptToolResult {
  readonly tool: string;
  readonly inputHash: string;
  readonly output: unknown;
}

const MAX_KEPT_TOOL_RESULTS = 32;

/** Key order differs between the agent's arguments and what reaches the server. */
const canonicalJson = (value: unknown): string =>
  JSON.stringify(value ?? {}, (_key, entry: unknown) =>
    entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).toSorted(([a], [b]) => (a < b ? -1 : 1)))
      : entry,
  );

const hashInput = (input: unknown) =>
  NodeCrypto.createHash("sha256").update(canonicalJson(input)).digest("hex");

const make = Effect.gen(function* () {
  const sessions = yield* Ref.make(new Map<ThreadId, McpProviderSessionConfig>());
  const htmlRenders = yield* Ref.make(new Map<ThreadId, ReadonlyArray<KeptHtmlRender>>());
  const toolResults = yield* Ref.make(new Map<ThreadId, ReadonlyArray<KeptToolResult>>());
  return McpProviderSessions.of({
    set: Effect.fn("McpProviderSessions.set")(function* (config) {
      const current = yield* Ref.get(sessions);
      if (current.get(config.threadId)?.providerSessionId !== config.providerSessionId) {
        yield* Ref.update(htmlRenders, (kept) => {
          const next = new Map(kept);
          next.delete(config.threadId);
          return next;
        });
        yield* Ref.update(toolResults, (kept) => {
          const next = new Map(kept);
          next.delete(config.threadId);
          return next;
        });
      }
      yield* Ref.update(sessions, (current) => new Map(current).set(config.threadId, config));
    }),
    read: Effect.fn("McpProviderSessions.read")(function (threadId) {
      return Ref.get(sessions).pipe(Effect.map((current) => current.get(threadId)));
    }),
    clear: Effect.fn("McpProviderSessions.clear")(function (threadId) {
      return Ref.update(sessions, (current) => {
        const next = new Map(current);
        next.delete(threadId);
        return next;
      }).pipe(
        Effect.andThen(
          Ref.update(htmlRenders, (current) => {
            const next = new Map(current);
            next.delete(threadId);
            return next;
          }),
        ),
        Effect.andThen(
          Ref.update(toolResults, (current) => {
            const next = new Map(current);
            next.delete(threadId);
            return next;
          }),
        ),
      );
    }),
    recordToolResult: Effect.fn("McpProviderSessions.recordToolResult")(
      function (threadId, call, output) {
        return Ref.update(toolResults, (current) =>
          new Map(current).set(
            threadId,
            [
              ...(current.get(threadId) ?? []),
              { tool: call.tool, inputHash: hashInput(call.input), output },
            ].slice(-MAX_KEPT_TOOL_RESULTS),
          ),
        );
      },
    ),
    takeToolResult: Effect.fn("McpProviderSessions.takeToolResult")(function (threadId, call) {
      return Ref.modify(toolResults, (current) => {
        const kept = current.get(threadId) ?? [];
        const inputHash = hashInput(call.input);
        let index = kept.findIndex(
          (entry) => entry.tool === call.tool && entry.inputHash === inputHash,
        );
        if (index === -1) {
          const sameTool = kept.flatMap((entry, keptIndex) =>
            entry.tool === call.tool ? [keptIndex] : [],
          );
          index = sameTool.length === 1 ? sameTool[0]! : -1;
        }
        if (index === -1) return [undefined, current];
        const rest = kept.filter((_, keptIndex) => keptIndex !== index);
        const next = new Map(current);
        if (rest.length === 0) {
          next.delete(threadId);
        } else {
          next.set(threadId, rest);
        }
        return [kept[index]!.output, next];
      });
    }),
    recordHtmlRender: Effect.fn("McpProviderSessions.recordHtmlRender")(
      function (threadId, input, reference) {
        return Ref.update(htmlRenders, (current) =>
          new Map(current).set(
            threadId,
            [
              ...(current.get(threadId) ?? []),
              {
                title: input.title,
                height: input.height,
                htmlLength: input.html.length,
                htmlHash: hashHtml(input.html),
                // Copy the tail so its backing storage cannot retain the entire HTML string.
                htmlEnd: Buffer.from(input.html.slice(-KEPT_HTML_END_LENGTH), "utf16le").toString(
                  "utf16le",
                ),
                reference,
              },
            ].slice(-MAX_KEPT_HTML_RENDERS),
          ),
        );
      },
    ),
    takeHtmlRender: Effect.fn("McpProviderSessions.takeHtmlRender")(
      function (threadId, input, reported) {
        return Ref.modify(htmlRenders, (current) => {
          const kept = current.get(threadId) ?? [];
          const index =
            reported === undefined
              ? matchingPageIndex(kept, input)
              : kept.findIndex((page) => page.reference.attachmentId === reported.attachmentId);
          if (index === -1) {
            return [undefined, current];
          }
          const rest = kept.filter((_, keptIndex) => keptIndex !== index);
          const next = new Map(current);
          if (rest.length === 0) {
            next.delete(threadId);
          } else {
            next.set(threadId, rest);
          }
          return [kept[index]!.reference, next];
        });
      },
    ),
  });
});

export const layer = Layer.effect(McpProviderSessions, make);
