/**
 * HermesChatHubService — thread hubs for Hermes gateway conversations.
 *
 * A hub is one pinned thread plus a set of platform channels. Conversations in
 * those channels appear in the hub thread as cards: run-less notification turn
 * items that follow the conversation's newest activity. Conversations get into
 * a hub two ways. The gateway appends a line to `<hermesHome>/t3-hub-links.jsonl`
 * whenever someone asks for one, which this service tails and turns into a
 * manual link to the named hub's thread. An auto-linking hub derives its own
 * links: its newest conversations, up to its cap, recomputed every pass. The
 * client can also link a conversation into any thread, or detach it.
 *
 * Manual links persist to an atomic JSON state file under the config state dir,
 * like the run sources; hub links are derived and never stored. Cards are
 * edited in place: an unlink does not remove a card that already exists, and
 * a card is only rewritten when its conversation's activity moved, so a quiet
 * hub costs one settings read per tick and nothing else.
 *
 * A card is never a message: `message.dispatch` would queue a provider run, so
 * cards land straight in the event sink like imported history, and the hub
 * thread is marked unread afterwards (a hub thread with no completed run
 * rejects that, which is fine and only logged).
 *
 * Cost: one settings read per tick with nothing configured; otherwise one
 * indexed channel read and one links-file tail per pass, 30s idle, 5s after a
 * pass that changed anything.
 *
 * @module HermesChatHubService
 */
import {
  CommandId,
  EventId,
  ThreadId,
  TurnItemId,
  type HermesChatHubsResult,
  type HermesChatLinkInput,
  type HermesChatLinksResult,
  type HermesChatUnlinkInput,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as ServerConfig from "../config.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as TurnItemPositionStore from "../orchestration-v2/TurnItemPositionStore.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { resolveEnabledHermesInstance, resolveHermesHome } from "./hermesCronState.ts";
import {
  readHermesChatChannels,
  readHermesChatTranscript,
  type HermesChatChannelsRow,
} from "./hermesChatState.ts";
import {
  conversationInHub,
  effectiveLinkedConversations,
  fnv1a,
  makeHermesHubLinksTailer,
  type EffectiveHermesChatLink,
  type HermesHubLinksTailer,
} from "./hermesChatHubs.ts";

const STATE_FILENAME = "hermes-chat-links.json";
/** File the gateway appends link requests to, under the Hermes home. */
const LINKS_FILENAME = "t3-hub-links.jsonl";
const IDLE_INTERVAL = Duration.seconds(30);
const AFTER_CHANGE_INTERVAL = Duration.seconds(5);
/** Conversations older than this leave the hub window, like the chat list. */
const HUB_WINDOW_SECONDS = 30 * 24 * 60 * 60;
/** Longest card summary or detail line. */
const CARD_TEXT_MAX = 200;
/** Id prefix every hub card turn item carries, so restarts recognize their own. */
const CARD_ID_PREFIX = ":hermes-chat:";

const PersistedLink = Schema.Struct({
  threadId: Schema.String,
  sessionKey: Schema.String,
  linkedAt: Schema.String,
});
const PersistedState = Schema.Struct({
  version: Schema.Literal(1),
  links: Schema.Array(PersistedLink),
});
const PersistedStateJson = Schema.fromJsonString(PersistedState);
const decodePersistedState = Schema.decodeUnknownEffect(PersistedStateJson);
const encodePersistedState = Schema.encodeEffect(PersistedStateJson);

interface ManualLink {
  readonly threadId: ThreadId;
  readonly sessionKey: string;
  /** ISO. */
  readonly linkedAt: string;
}

function linkKey(threadId: ThreadId, sessionKey: string): string {
  return `${threadId}\u0000${sessionKey}`;
}

function clip(value: string): string {
  return value.length <= CARD_TEXT_MAX ? value : `${value.slice(0, CARD_TEXT_MAX - 1).trimEnd()}…`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** The hub a links-file line names, by id first, then by name, case-insensitively. */
function resolveHub<T extends { id: string; name: string }>(
  hubs: readonly T[],
  named: string,
): T | null {
  const key = named.trim().toLowerCase();
  if (!key) return null;
  return (
    hubs.find((hub) => hub.id.toLowerCase() === key) ??
    hubs.find((hub) => hub.name.toLowerCase() === key) ??
    null
  );
}

/** Activity key of a card the thread already holds, from its updatedAt. */
function activityKeyFromUpdatedAt(updatedAt: DateTime.DateTime): string {
  return (DateTime.toEpochMillis(updatedAt) / 1000).toFixed(3);
}

export class HermesChatHubService extends Context.Service<
  HermesChatHubService,
  {
    /** Every configured hub, with how many conversations currently sit in its thread. */
    readonly listHubs: Effect.Effect<HermesChatHubsResult>;
    /** Links a gateway conversation's card into a thread. */
    readonly link: (input: HermesChatLinkInput) => Effect.Effect<HermesChatLinksResult>;
    /** Detaches a conversation's card; every thread's when threadId is omitted. */
    readonly unlink: (input: HermesChatUnlinkInput) => Effect.Effect<HermesChatLinksResult>;
    /** Every link that currently holds, manual and hub-derived. */
    readonly links: Effect.Effect<HermesChatLinksResult>;
    /** The links that currently hold: manual plus hub-derived, newest activity first. */
    readonly effectiveLinkedConversations: Effect.Effect<ReadonlyArray<EffectiveHermesChatLink>>;
    /** One watcher pass: tail the links file, then write cards that moved. */
    readonly sync: Effect.Effect<void>;
    /** Starts the watcher loop. Called once from the orchestration reactor. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3-hermes/hermes/HermesChatHubService") {}

const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;

  const statePath = path.join(config.stateDir, STATE_FILENAME);
  const stateMutex = yield* Semaphore.make(1);
  const wake = yield* Queue.sliding<void>(1);

  /** Manual links, keyed `${threadId}\u0000${sessionKey}`. Hub links are never stored. */
  const manualLinks = new Map<string, ManualLink>();
  /** Cards each thread already holds: item id → activity key. Seeded from the projection. */
  const writtenCards = new Map<ThreadId, Map<string, string>>();
  let unreadCounter = 0;

  // A missing or unreadable file means no links, the quiet side.
  yield* Effect.gen(function* () {
    const raw = yield* fs.readFileString(statePath).pipe(Effect.orElseSucceed(() => ""));
    if (!raw.trim()) return;
    const decoded = yield* decodePersistedState(raw).pipe(Effect.option);
    if (Option.isNone(decoded)) return;
    for (const entry of decoded.value.links) {
      const threadId = entry.threadId.trim();
      const sessionKey = entry.sessionKey.trim();
      if (!threadId || !sessionKey || !entry.linkedAt.trim()) continue;
      const link = { threadId: ThreadId.make(threadId), sessionKey, linkedAt: entry.linkedAt };
      manualLinks.set(linkKey(link.threadId, link.sessionKey), link);
    }
  });

  const saveState = stateMutex.withPermits(1)(
    Effect.gen(function* () {
      const links = [...manualLinks.values()].map((link) => ({
        threadId: link.threadId as string,
        sessionKey: link.sessionKey,
        linkedAt: link.linkedAt,
      }));
      const contents = yield* encodePersistedState({ version: 1, links });
      yield* writeFileStringAtomically({ filePath: statePath, contents: `${contents}\n` }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      );
    }).pipe(
      // The in-memory links stay authoritative for this process; a failed save
      // only costs them across a restart, so it is logged, not surfaced.
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not save Hermes chat links").pipe(
          Effect.annotateLogs({ statePath, cause }),
        ),
      ),
    ),
  );

  // Settings plus the Hermes home they resolve to, or null when settings fail.
  // `home` is null when Hermes is off: hubs still list, but nothing links.
  const settingsContext = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (settings === null) return null;
    const instance = resolveEnabledHermesInstance(settings);
    if (instance === null) return { settings, home: null as string | null };
    const environment = yield* mergeProviderInstanceEnvironment(instance.environment);
    return { settings, home: resolveHermesHome(environment) as string | null };
  });

  const channelsWindow = (home: string): Effect.Effect<readonly HermesChatChannelsRow[]> =>
    Effect.gen(function* () {
      const nowSeconds = (yield* Clock.currentTimeMillis) / 1000;
      const rows = yield* Effect.sync(() =>
        readHermesChatChannels(path.join(home, "state.db"), {
          sinceSeconds: nowSeconds - HUB_WINDOW_SECONDS,
        }),
      );
      return rows ?? [];
    });

  /** Manual links only, for when Hermes is off and nothing can be derived. */
  const manualLinksAsEffective = (): ReadonlyArray<EffectiveHermesChatLink> =>
    [...manualLinks.values()].map((link) => ({
      threadId: link.threadId,
      sessionKey: link.sessionKey,
      source: "manual" as const,
      activityAt: 0,
    }));

  const effectiveLinks: HermesChatHubService["Service"]["effectiveLinkedConversations"] =
    Effect.gen(function* () {
      const context = yield* settingsContext;
      if (context === null || context.home === null) return manualLinksAsEffective();
      const rows = yield* channelsWindow(context.home);
      return effectiveLinkedConversations({
        hubs: context.settings.integrations.hermesHubs,
        manualLinks: [...manualLinks.values()],
        conversations: rows,
      });
    });

  const linksResult = Effect.gen(function* () {
    const linkedAtByKey = new Map(
      [...manualLinks.values()].map((link) => [
        linkKey(link.threadId, link.sessionKey),
        link.linkedAt,
      ]),
    );
    const links = yield* effectiveLinks;
    return {
      links: links.map((link) => ({
        sessionKey: link.sessionKey,
        threadId: link.threadId,
        source: link.source,
        linkedAt:
          link.source === "manual"
            ? (linkedAtByKey.get(linkKey(link.threadId, link.sessionKey)) ?? null)
            : null,
      })),
    } satisfies HermesChatLinksResult;
  });

  const listHubs: HermesChatHubService["Service"]["listHubs"] = Effect.gen(function* () {
    const context = yield* settingsContext;
    if (context === null) return { hubs: [] };
    const hubSettings = context.settings.integrations.hermesHubs;
    if (context.home === null) {
      // Nothing can be linked while Hermes is off, so nothing is.
      return { hubs: hubSettings.map((hub) => ({ ...hub, linkedCount: 0 })) };
    }
    const rows = yield* channelsWindow(context.home);
    const links = effectiveLinkedConversations({
      hubs: hubSettings,
      manualLinks: [...manualLinks.values()],
      conversations: rows,
    });
    return {
      hubs: hubSettings.map((hub) => ({
        ...hub,
        linkedCount:
          hub.threadId === null ? 0 : links.filter((link) => link.threadId === hub.threadId).length,
      })),
    } satisfies HermesChatHubsResult;
  });

  const link: HermesChatHubService["Service"]["link"] = Effect.fn("HermesChatHubService.link")(
    function* (input) {
      const linkedAt = DateTime.formatIso(yield* DateTime.now);
      manualLinks.set(linkKey(input.threadId, input.sessionKey), {
        threadId: input.threadId,
        sessionKey: input.sessionKey,
        linkedAt,
      });
      yield* saveState;
      // The card appears on the next pass; wake it now rather than waiting.
      yield* Queue.offer(wake, undefined);
      return yield* linksResult;
    },
  );

  const unlink: HermesChatHubService["Service"]["unlink"] = Effect.fn(
    "HermesChatHubService.unlink",
  )(function* (input) {
    for (const [key, link] of manualLinks) {
      if (link.sessionKey !== input.sessionKey) continue;
      if (input.threadId !== undefined && link.threadId !== input.threadId) continue;
      manualLinks.delete(key);
    }
    // Cards already written stay; removal is a later milestone, not this one.
    yield* saveState;
    return yield* linksResult;
  });

  // ── Watcher ────────────────────────────────────────────────────────────

  // The gateway rejects a mark-unread for a thread with no completed run; the
  // card is still there, so that rejection is expected and only logged.
  const dispatch = (command: OrchestrationV2ServerCommand) =>
    orchestrator.dispatch(command).pipe(
      Effect.catchTags({
        OrchestratorCommandPreviouslyRejectedError: () => Effect.void,
        OrchestratorDispatchError: (error) =>
          Effect.logWarning("Hermes chat hub could not mark its thread unread").pipe(
            Effect.annotateLogs({ cause: error.cause }),
          ),
      }),
      Effect.asVoid,
    );

  // One tailer per links file, so a moved HERMES_HOME starts a fresh offset.
  let tailerState: { readonly filePath: string; readonly tailer: HermesHubLinksTailer } | null =
    null;
  const linksTailer = (home: string) => {
    const filePath = path.join(home, LINKS_FILENAME);
    if (tailerState?.filePath !== filePath) {
      tailerState = { filePath, tailer: makeHermesHubLinksTailer(filePath) };
    }
    return tailerState.tailer;
  };

  /** One pass. Returns whether anything changed, which shortens the next tick. */
  const pass = Effect.gen(function* () {
    const context = yield* settingsContext;
    if (context === null) return false;
    const hubSettings = context.settings.integrations.hermesHubs;
    // With no hub configured there is nothing to link, tail, or write.
    if (hubSettings.length === 0 || context.home === null) return false;
    const home = context.home;

    let changed = false;
    let stateDirty = false;
    const rows = yield* channelsWindow(home);

    // Links-file lines become manual links to the named hub's thread. Guards:
    // the hub must exist and have a thread, and for links the conversation
    // must sit in the window with a channel the hub names.
    const tail = linksTailer(home).read();
    if (tail.skipped > 0) {
      yield* Effect.logWarning("Hermes hub links file had unreadable lines").pipe(
        Effect.annotateLogs({ filePath: path.join(home, LINKS_FILENAME), skipped: tail.skipped }),
      );
    }
    const ignore = (sessionKey: string, hub: string, reason: string) =>
      Effect.logWarning("Hermes hub link line ignored").pipe(
        Effect.annotateLogs({ sessionKey, hub, reason }),
      );
    for (const line of tail.lines) {
      const hub = resolveHub(hubSettings, line.hub);
      if (hub === null) {
        yield* ignore(line.sessionKey, line.hub, "unknownHub");
        continue;
      }
      if (hub.threadId === null) {
        yield* ignore(line.sessionKey, line.hub, "hubHasNoThread");
        continue;
      }
      if (line.action === "unlink") {
        if (manualLinks.delete(linkKey(hub.threadId, line.sessionKey))) {
          stateDirty = true;
          changed = true;
        }
        continue;
      }
      const row = rows.find((entry) => entry.sessionKey === line.sessionKey);
      if (row === undefined) {
        yield* ignore(line.sessionKey, line.hub, "conversationNotInWindow");
        continue;
      }
      if (!conversationInHub(row, hub)) {
        yield* ignore(line.sessionKey, line.hub, "channelNotInHub");
        continue;
      }
      const linkedAt = line.at?.trim() || DateTime.formatIso(yield* DateTime.now);
      manualLinks.set(linkKey(hub.threadId, line.sessionKey), {
        threadId: hub.threadId,
        sessionKey: line.sessionKey,
        linkedAt,
      });
      stateDirty = true;
      changed = true;
    }
    if (stateDirty) yield* saveState;

    // Cards: one per effective link, written or edited only when its
    // conversation's activity moved since the thread last held it.
    const links = effectiveLinkedConversations({
      hubs: hubSettings,
      manualLinks: [...manualLinks.values()],
      conversations: rows,
    });
    const dbPath = path.join(home, "state.db");
    const events: OrchestrationV2DomainEvent[] = [];
    const pending: Array<{ readonly item: OrchestrationV2TurnItem; readonly activityKey: string }> =
      [];
    const unreadThreads = new Set<ThreadId>();
    for (const link of links) {
      const row = rows.find((entry) => entry.sessionKey === link.sessionKey);
      if (row === undefined) continue;
      const activityKey = row.lastActivityAt.toFixed(3);
      const itemId = TurnItemId.make(`${link.threadId}${CARD_ID_PREFIX}${link.sessionKey}`);
      let written = writtenCards.get(link.threadId);
      if (written === undefined) {
        // First pass after boot: a card the thread already holds must not be
        // rewritten, so seed from the projection before deciding anything.
        const records = yield* projections.getThreadRecords(link.threadId, ["turnItems"], {
          turnItemRunIds: [null],
        });
        written = new Map(
          records.turnItems
            .filter((item) => item.id.startsWith(`${link.threadId}${CARD_ID_PREFIX}`))
            .map((item) => [item.id, activityKeyFromUpdatedAt(item.updatedAt)]),
        );
        writtenCards.set(link.threadId, written);
      }
      if (written.get(itemId) === activityKey) continue;

      // The conversation's detail is only worth a read once it moved.
      const detail = yield* Effect.sync(() => readHermesChatTranscript(dbPath, link.sessionKey, 0));
      const conversation = detail?.conversation ?? null;
      if (conversation === null) continue;
      const summary = clip(
        oneLine(
          conversation.title ??
            conversation.displayName ??
            conversation.userName ??
            link.sessionKey,
        ),
      );
      const preview = conversation.latestMessagePreview;
      const at = DateTime.makeUnsafe(Math.round(row.lastActivityAt * 1000));
      const item: OrchestrationV2TurnItem = {
        id: itemId,
        threadId: link.threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        // Placed by the turn item position store when the item is written.
        ordinal: 0,
        status: "completed",
        title: null,
        startedAt: at,
        completedAt: at,
        updatedAt: at,
        type: "notification",
        source: { kind: "hermes_chat", sessionKey: link.sessionKey },
        outcome: "updated",
        summary,
        ...(preview === null ? {} : { detail: clip(oneLine(preview)) }),
      };
      const placed = yield* positions.normalize(item);
      events.push({
        id: EventId.make(`${itemId}:${activityKey}:${fnv1a(`${summary}|${preview ?? ""}`)}`),
        type: "turn-item.updated",
        threadId: link.threadId,
        occurredAt: placed.updatedAt,
        payload: placed,
      });
      pending.push({ item: placed, activityKey });
      unreadThreads.add(link.threadId);
    }
    if (events.length > 0) {
      // Only mark the cards written once the write took: a failed write must
      // be retried next pass exactly as it was.
      yield* eventSink.write({ events });
      for (const { item, activityKey } of pending) {
        const written = writtenCards.get(item.threadId);
        written?.set(item.id, activityKey);
      }
      for (const threadId of unreadThreads) {
        yield* dispatch({
          type: "thread.mark-unread",
          commandId: CommandId.make(`hermes-chat:unread:${threadId}:${(unreadCounter += 1)}`),
          threadId,
        });
      }
      changed = true;
    }
    return changed;
  });

  const passMutex = yield* Semaphore.make(1);
  const safePass = passMutex.withPermits(1)(
    pass.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Hermes chat hub watcher pass failed").pipe(
          Effect.annotateLogs({ cause }),
          Effect.as(false),
        ),
      ),
    ),
  );

  const start: HermesChatHubService["Service"]["start"] = () =>
    forkParked(
      Effect.gen(function* () {
        for (;;) {
          const changed = yield* safePass;
          yield* Effect.raceFirst(
            Queue.take(wake),
            Effect.sleep(changed ? AFTER_CHANGE_INTERVAL : IDLE_INTERVAL),
          );
        }
      }),
    );

  return HermesChatHubService.of({
    listHubs,
    link,
    unlink,
    links: linksResult,
    effectiveLinkedConversations: effectiveLinks,
    sync: Effect.asVoid(safePass),
    start,
  });
});

export const layer = Layer.effect(HermesChatHubService, make);
