/**
 * HindsightService — the environment's side of the Memory tab.
 *
 * Hindsight is an HTTP service on the same host, usually bound to loopback.
 * Every request a client makes goes through here, which is the whole point:
 * the panel works identically from a phone, a tunnel, or the desktop app, and
 * the API key never leaves this process.
 *
 * Request/response only. There is no poll, no subscription and no cache of
 * memories — the panel asks when the user asks, and Hindsight is a local
 * process answering in milliseconds. The one thing that is remembered is the
 * compatibility probe: `GET /version` is hit once and its verdict reused, so a
 * version mismatch is reported once at the top of the panel instead of turning
 * every keystroke into a failed round trip.
 *
 * Reads never fail. An unconfigured or unreachable Hindsight comes back as a
 * {@link HindsightStatus} on an empty result, because "not running" is
 * something the panel renders in words with a retry button, not an error toast
 * over a blank list. Writes do fail, with the same vocabulary as a reason —
 * the user pressed a button and is owed a straight answer.
 *
 * The service is inert when `integrations.hindsight.enabled` is unset: no
 * socket is opened and the client is told the tab should not render.
 *
 * @module HindsightService
 */
import {
  HINDSIGHT_CONTRACT_VERSION,
  HINDSIGHT_DEFAULT_PAGE_SIZE,
  HINDSIGHT_MAX_PAGE_SIZE,
  HINDSIGHT_TARGET_API_VERSION,
  HindsightBankId,
  type HindsightAvailability,
  type HindsightBank,
  type HindsightBanksResult,
  type HindsightBrowseInput,
  HindsightError,
  type HindsightListBanksInput,
  type HindsightMemory,
  type HindsightMemoryResult,
  type HindsightRecallInput,
  type HindsightReflectInput,
  type HindsightReflectResult,
  type HindsightRetainInput,
  type HindsightRetainResult,
  type HindsightStatsInput,
  type HindsightStatsResult,
  type HindsightStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import * as ServerSettings from "../../serverSettings.ts";
import {
  HindsightBankListResponse,
  HindsightBankStatsResponse,
  HindsightListMemoriesResponse,
  HindsightMentalModelListResponse,
  HindsightRecallResponse,
  HindsightReflectResponse,
  HindsightRetainResponse,
  HindsightVersionResponse,
  bankFromListItem,
  factTypesFor,
  filterMentalModels,
  hindsightPaths,
  hindsightUrl,
  includesMentalModels,
  memoryFromMentalModel,
  memoryFromRecallResult,
  memoryFromUnit,
  sortByRememberedAtDesc,
  statsFromResponse,
} from "./hindsightApi.ts";

/**
 * Ceiling on a single Hindsight call.
 *
 * Generous because `reflect` runs an LLM loop, and a reflection that takes
 * forty seconds is working, not broken. Reads finish in milliseconds against a
 * local instance, so the same ceiling costs them nothing.
 */
const REQUEST_TIMEOUT = Duration.seconds(60);

/** Shorter ceiling for the probe: it only reads a constant. */
const PROBE_TIMEOUT = Duration.seconds(5);

/**
 * Recall asks for a token budget rather than a row count, so a page size is
 * translated into roughly this many tokens per row. Overshooting is harmless —
 * results are truncated to the requested page afterwards.
 */
const RECALL_TOKENS_PER_RESULT = 220;

/** What the compatibility probe concluded, reused until a refresh. */
interface HindsightProbe {
  readonly availability: HindsightAvailability;
  readonly detail: string | null;
  readonly apiVersion: string | null;
}

/** Effective connection settings, or `null` when the integration is off. */
interface HindsightConnection {
  readonly baseUrl: string;
  readonly apiKey: string | null;
  readonly defaultBank: string | null;
}

const NOT_CONFIGURED: HindsightProbe = {
  availability: "notConfigured",
  detail: "Hindsight is not configured for this environment.",
  apiVersion: null,
};

function statusOf(probe: HindsightProbe): HindsightStatus {
  return {
    contractVersion: HINDSIGHT_CONTRACT_VERSION,
    availability: probe.availability,
    detail: probe.detail,
    apiVersion: probe.apiVersion,
    targetApiVersion: HINDSIGHT_TARGET_API_VERSION,
  };
}

/**
 * Whether a decoded `api_version` falls on the same major as the version this
 * build was transcribed from.
 *
 * A Hindsight that bumps its minor or patch keeps answering in the same shapes;
 * a major bump is when Hindsight stops guaranteeing the shapes it used to send,
 * which is the one case that must render as `incompatible`. `api_version` is a
 * bare string Hindsight controls, so an unparsable first segment is treated as
 * incompatible rather than guessed.
 */
function isCompatibleApiVersion(apiVersion: string): boolean {
  const foundMajor = apiVersion.trim().split(".")[0] ?? "";
  const targetMajor = HINDSIGHT_TARGET_API_VERSION.split(".")[0] ?? "";
  return foundMajor.length > 0 && foundMajor === targetMajor;
}

/**
 * The failure reason a read ended with, as the availability a panel renders.
 *
 * Every non-healthy verdict shares one shape, but each keeps its words: the
 * panel says "not answering" for `offline`, "update one of the two sides" for
 * `incompatible`, and shows the failure's own detail for `requestFailed`.
 */
function availabilityForReadFailure(reason: HindsightError["reason"]): HindsightAvailability {
  switch (reason) {
    case "offline":
      return "offline";
    case "incompatible":
      return "incompatible";
    case "notConfigured":
      return "notConfigured";
    case "unknownBank":
    case "requestFailed":
      return "requestFailed";
  }
}

function emptyMemoryResult(probe: HindsightProbe): HindsightMemoryResult {
  return { status: statusOf(probe), memories: [], hasMore: false };
}

/**
 * A probe verdict as a write failure.
 *
 * Reads and writes agree on vocabulary — the only difference is that a write
 * has nowhere to put a status, so the same words arrive as a typed error.
 */
function probeFailure(probe: HindsightProbe): HindsightError {
  const reason =
    probe.availability === "notConfigured"
      ? ("notConfigured" as const)
      : probe.availability === "incompatible"
        ? ("incompatible" as const)
        : probe.availability === "requestFailed"
          ? ("requestFailed" as const)
          : ("offline" as const);
  return new HindsightError({
    reason,
    detail: probe.detail ?? "Hindsight is unavailable.",
  });
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return HINDSIGHT_DEFAULT_PAGE_SIZE;
  return Math.max(1, Math.min(HINDSIGHT_MAX_PAGE_SIZE, Math.floor(limit)));
}

export class HindsightService extends Context.Service<
  HindsightService,
  {
    /**
     * Banks plus the compatibility verdict — everything the panel needs to
     * decide what to render.
     */
    readonly listBanks: (input: HindsightListBanksInput) => Effect.Effect<HindsightBanksResult>;

    /** Recent memories, newest first. The view with no query typed. */
    readonly browse: (input: HindsightBrowseInput) => Effect.Effect<HindsightMemoryResult>;

    /** Semantic search over a bank. */
    readonly recall: (input: HindsightRecallInput) => Effect.Effect<HindsightMemoryResult>;

    /**
     * How big the bank is. Answers with `stats: null` rather than zeroes when
     * Hindsight could not say, so the strip disappears instead of lying.
     */
    readonly stats: (input: HindsightStatsInput) => Effect.Effect<HindsightStatsResult>;

    /** Write one note. Fails rather than silently swallowing a lost note. */
    readonly retain: (
      input: HindsightRetainInput,
    ) => Effect.Effect<HindsightRetainResult, HindsightError>;

    /** Ask Hindsight to reason over the bank now. */
    readonly reflect: (
      input: HindsightReflectInput,
    ) => Effect.Effect<HindsightReflectResult, HindsightError>;
  }
>()("t3/integrations/hindsight/HindsightService") {}

export const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const client = yield* HttpClient.HttpClient;

  /** `null` whenever the integration is absent or switched off. */
  const connection = Effect.map(
    settingsService.getSettings.pipe(Effect.orElseSucceed(() => null)),
    (settings): HindsightConnection | null => {
      const hindsight = settings?.integrations.hindsight;
      if (!hindsight || !hindsight.enabled) return null;
      const baseUrl = hindsight.baseUrl.trim();
      if (baseUrl.length === 0) return null;
      const apiKey = hindsight.apiKey?.trim() ?? "";
      const defaultBank = hindsight.defaultBank?.trim() ?? "";
      return {
        baseUrl,
        apiKey: apiKey.length === 0 ? null : apiKey,
        defaultBank: defaultBank.length === 0 ? null : defaultBank,
      };
    },
  );

  const probeRef = yield* Ref.make<HindsightProbe | null>(null);

  const authorized = (request: HttpClientRequest.HttpClientRequest, apiKey: string | null) =>
    apiKey === null
      ? request
      : HttpClientRequest.setHeader(request, "authorization", `Bearer ${apiKey}`);

  /**
   * One call, decoded.
   *
   * Every way this can go wrong is folded into the vocabulary the panel
   * speaks: a transport error or a timeout is `offline`, a body that will not
   * decode is `incompatible`, and anything else Hindsight says is
   * `requestFailed` with its status code.
   */
  const send = <A, I>(
    request: HttpClientRequest.HttpClientRequest,
    schema: Schema.Codec<A, I, never, never>,
    options: { readonly apiKey: string | null; readonly timeout: Duration.Duration },
  ): Effect.Effect<A, HindsightError> =>
    Effect.gen(function* () {
      const response = yield* client.execute(authorized(request, options.apiKey)).pipe(
        Effect.timeoutOption(options.timeout),
        Effect.orElseSucceed(() => Option.none()),
      );

      if (Option.isNone(response)) {
        return yield* new HindsightError({
          reason: "offline",
          detail: "Hindsight did not answer.",
        });
      }

      const httpResponse = response.value;
      if (httpResponse.status === 404) {
        return yield* new HindsightError({
          reason: "unknownBank",
          detail: "Hindsight does not have that memory bank.",
        });
      }
      if (httpResponse.status < 200 || httpResponse.status >= 300) {
        return yield* new HindsightError({
          reason: "requestFailed",
          detail: `Hindsight answered with status ${httpResponse.status}.`,
        });
      }

      return yield* httpResponse.json.pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(schema)),
        Effect.mapError(
          (cause) =>
            new HindsightError({
              reason: "incompatible",
              detail: "Hindsight answered in a shape this version of T3 Code does not understand.",
              cause,
            }),
        ),
      );
    });

  /**
   * The cached compatibility verdict, probing once if needed.
   *
   * Only a healthy verdict is reused. `ready` and `notConfigured` are the two
   * answers that cannot change on their own, so re-probing them would be noise;
   * every other verdict is re-asked, which is how the panel's retry button
   * recovers without a server restart:
   *
   * - the user starts Hindsight and the stale `offline` verdict is thrown away;
   * - the user upgrades (or downgrades) Hindsight and the stale `incompatible`
   *   verdict is thrown away;
   * - a read that failed mid-flight (bank deleted underneath the panel, for
   *   example) re-probes on the next attempt instead of trusting the cache.
   *
   * `refresh` (the panel's retry) forces the probe regardless.
   */
  const probe = (options: { readonly refresh: boolean }) =>
    Effect.gen(function* () {
      const settings = yield* connection;
      if (settings === null) {
        yield* Ref.set(probeRef, null);
        return { probe: NOT_CONFIGURED, connection: null } as const;
      }

      const cached = yield* Ref.get(probeRef);
      if (
        cached !== null &&
        !options.refresh &&
        (cached.availability === "ready" || cached.availability === "notConfigured")
      ) {
        return { probe: cached, connection: settings } as const;
      }

      const version = yield* send(
        HttpClientRequest.get(hindsightUrl(settings.baseUrl, hindsightPaths.version())).pipe(
          HttpClientRequest.setHeader("accept", "application/json"),
        ),
        HindsightVersionResponse,
        { apiKey: settings.apiKey, timeout: PROBE_TIMEOUT },
      ).pipe(Effect.result);

      const next: HindsightProbe = Result.isSuccess(version)
        ? isCompatibleApiVersion(version.success.api_version)
          ? { availability: "ready", detail: null, apiVersion: version.success.api_version }
          : {
              availability: "incompatible",
              detail: `Hindsight reports API ${version.success.api_version}, but T3 Code targets ${HINDSIGHT_TARGET_API_VERSION}. The major versions differ, so the panel cannot safely decode its answers.`,
              apiVersion: version.success.api_version,
            }
        : version.failure.reason === "incompatible"
          ? {
              availability: "incompatible",
              detail: `Hindsight did not report a version this build understands. T3 Code targets Hindsight API ${HINDSIGHT_TARGET_API_VERSION}.`,
              apiVersion: null,
            }
          : {
              availability: "offline",
              detail: "Hindsight is configured but not answering on this host.",
              apiVersion: null,
            };

      yield* Ref.set(probeRef, next);
      return { probe: next, connection: settings } as const;
    });

  /**
   * Runs a read, turning any failure into a status the panel can render.
   *
   * A read that fails mid-flight also invalidates the cached verdict, so the
   * next attempt re-probes rather than trusting a `ready` that has since
   * stopped being true. `invalidatesProbe: false` opts a read out of that,
   * for a read whose failure says nothing about whether the rest of the panel
   * still works — see {@link stats}.
   */
  const readOrStatus = <A>(
    run: (settings: HindsightConnection, probe: HindsightProbe) => Effect.Effect<A, HindsightError>,
    fallback: (probe: HindsightProbe) => A,
    options?: { readonly invalidatesProbe?: boolean },
  ): Effect.Effect<A> =>
    Effect.gen(function* () {
      const probed = yield* probe({ refresh: false });
      if (probed.connection === null || probed.probe.availability !== "ready") {
        return fallback(probed.probe);
      }
      const result = yield* run(probed.connection, probed.probe).pipe(Effect.result);
      if (Result.isSuccess(result)) return result.success;

      const availability = availabilityForReadFailure(result.failure.reason);
      const failed: HindsightProbe = {
        availability,
        detail:
          availability === "offline"
            ? "Hindsight stopped answering on this host."
            : result.failure.detail,
        apiVersion: probed.probe.apiVersion,
      };

      if (availability !== "ready" && options?.invalidatesProbe !== false) {
        yield* Ref.set(probeRef, failed);
      }
      return fallback(failed);
    });

  /** A write only runs against a `ready` Hindsight; otherwise it says why not. */
  const write = <A>(
    run: (settings: HindsightConnection, probe: HindsightProbe) => Effect.Effect<A, HindsightError>,
  ): Effect.Effect<A, HindsightError> =>
    Effect.gen(function* () {
      const probed = yield* probe({ refresh: false });
      if (probed.connection === null || probed.probe.availability !== "ready") {
        return yield* probeFailure(probed.probe);
      }
      return yield* run(probed.connection, probed.probe);
    });

  const fetchMentalModels = (settings: HindsightConnection, bank: string, limit: number) =>
    send(
      HttpClientRequest.get(hindsightUrl(settings.baseUrl, hindsightPaths.mentalModels(bank))).pipe(
        HttpClientRequest.setUrlParams({ detail: "content", limit: String(limit) }),
        HttpClientRequest.setHeader("accept", "application/json"),
      ),
      HindsightMentalModelListResponse,
      { apiKey: settings.apiKey, timeout: REQUEST_TIMEOUT },
    );

  const listBanks = (_input: HindsightListBanksInput) =>
    readOrStatus<HindsightBanksResult>(
      (settings, probed) =>
        Effect.map(
          send(
            HttpClientRequest.get(hindsightUrl(settings.baseUrl, hindsightPaths.banks())).pipe(
              HttpClientRequest.setHeader("accept", "application/json"),
            ),
            HindsightBankListResponse,
            { apiKey: settings.apiKey, timeout: REQUEST_TIMEOUT },
          ),
          (response): HindsightBanksResult => {
            const banks: ReadonlyArray<HindsightBank> = response.banks.map(bankFromListItem);
            // A configured default that no longer exists is worse than no
            // default: the panel would preselect a bank every read 404s on.
            const defaultBank =
              settings.defaultBank !== null &&
              banks.some((bank) => bank.id === settings.defaultBank)
                ? HindsightBankId.make(settings.defaultBank)
                : null;
            return { status: statusOf(probed), banks, defaultBank };
          },
        ),
      (probed) => ({ status: statusOf(probed), banks: [], defaultBank: null }),
    );

  const browse = (input: HindsightBrowseInput) =>
    readOrStatus<HindsightMemoryResult>(
      (settings, probed) =>
        Effect.gen(function* () {
          const limit = clampLimit(input.limit);
          const factTypes = factTypesFor(input.pathway);

          // Asking for one more row than the page is how "there is more" is
          // known without a second count query.
          const units =
            factTypes.length === 0
              ? null
              : yield* send(
                  HttpClientRequest.get(
                    hindsightUrl(settings.baseUrl, hindsightPaths.listMemories(input.bank)),
                  ).pipe(
                    HttpClientRequest.setUrlParams({
                      limit: String(limit + 1),
                      offset: "0",
                      // One type means a filter; three means "no filter", which
                      // Hindsight spells as an absent parameter.
                      ...(factTypes.length === 1 ? { type: factTypes[0] } : {}),
                    }),
                    HttpClientRequest.setHeader("accept", "application/json"),
                  ),
                  HindsightListMemoriesResponse,
                  { apiKey: settings.apiKey, timeout: REQUEST_TIMEOUT },
                );

          const models = includesMentalModels(input.pathway)
            ? yield* fetchMentalModels(settings, input.bank, limit + 1)
            : null;

          const memories: ReadonlyArray<HindsightMemory> = sortByRememberedAtDesc([
            ...(units?.items ?? []).map(memoryFromUnit),
            ...(models?.items ?? []).map(memoryFromMentalModel),
          ]);

          return {
            status: statusOf(probed),
            memories: memories.slice(0, limit),
            hasMore: memories.length > limit,
          } satisfies HindsightMemoryResult;
        }),
      emptyMemoryResult,
    );

  const recall = (input: HindsightRecallInput) =>
    readOrStatus<HindsightMemoryResult>(
      (settings, probed) =>
        Effect.gen(function* () {
          const limit = clampLimit(input.limit);
          const factTypes = factTypesFor(input.pathway);

          const recalled =
            factTypes.length === 0
              ? null
              : yield* send(
                  HttpClientRequest.post(
                    hindsightUrl(settings.baseUrl, hindsightPaths.recall(input.bank)),
                  ).pipe(
                    HttpClientRequest.bodyJsonUnsafe({
                      query: input.query,
                      types: factTypes,
                      // Drops raw facts that a returned observation already
                      // supersedes, so the list does not read as duplicated.
                      prefer_observations: factTypes.includes("observation"),
                      max_tokens: limit * RECALL_TOKENS_PER_RESULT,
                    }),
                    HttpClientRequest.setHeader("accept", "application/json"),
                  ),
                  HindsightRecallResponse,
                  { apiKey: settings.apiKey, timeout: REQUEST_TIMEOUT },
                );

          // Hindsight has no ranked query over mental models, so a query
          // narrows them by substring instead. See `filterMentalModels`.
          const models = includesMentalModels(input.pathway)
            ? filterMentalModels(
                (yield* fetchMentalModels(settings, input.bank, HINDSIGHT_MAX_PAGE_SIZE)).items,
                input.query,
              )
            : [];

          // Ranked results first, in Hindsight's order; matched mental models
          // after, since their "score" is a substring hit and not comparable.
          const memories: ReadonlyArray<HindsightMemory> = [
            ...(recalled?.results ?? []).map(memoryFromRecallResult),
            ...models.map(memoryFromMentalModel),
          ];

          return {
            status: statusOf(probed),
            memories: memories.slice(0, limit),
            hasMore: memories.length > limit,
          } satisfies HindsightMemoryResult;
        }),
      emptyMemoryResult,
    );

  /**
   * Bank counts for the strip above the list.
   *
   * Deliberately does not invalidate the cached probe. Stats is one endpoint
   * out of five, and a Hindsight that fails it — an older build without the
   * route, a stats query that timed out on a huge bank — is still perfectly
   * able to answer recalls. Poisoning the shared verdict here would replace a
   * working list with "Memory could not be read" because a decoration failed.
   */
  const stats = (input: HindsightStatsInput) =>
    readOrStatus<HindsightStatsResult>(
      (settings, probed) =>
        Effect.map(
          send(
            HttpClientRequest.get(
              hindsightUrl(settings.baseUrl, hindsightPaths.stats(input.bank)),
            ).pipe(HttpClientRequest.setHeader("accept", "application/json")),
            HindsightBankStatsResponse,
            { apiKey: settings.apiKey, timeout: REQUEST_TIMEOUT },
          ),
          (response): HindsightStatsResult => ({
            status: statusOf(probed),
            stats: statsFromResponse(response),
          }),
        ),
      (probed) => ({ status: statusOf(probed), stats: null }),
      { invalidatesProbe: false },
    );

  const retain = (input: HindsightRetainInput) =>
    write((settings, probed) =>
      Effect.map(
        send(
          HttpClientRequest.post(
            hindsightUrl(settings.baseUrl, hindsightPaths.retain(input.bank)),
          ).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              items: [{ content: input.text }],
              // Synchronous: the confirmation the user sees should be the
              // truth, not a promise to extract facts later.
              async: false,
            }),
            HttpClientRequest.setHeader("accept", "application/json"),
          ),
          HindsightRetainResponse,
          { apiKey: settings.apiKey, timeout: REQUEST_TIMEOUT },
        ),
        (response): HindsightRetainResult => ({
          status: statusOf(probed),
          itemsCount: response.items_count,
        }),
      ),
    );

  const reflect = (input: HindsightReflectInput) =>
    write((settings, probed) =>
      Effect.map(
        send(
          HttpClientRequest.post(
            hindsightUrl(settings.baseUrl, hindsightPaths.reflect(input.bank)),
          ).pipe(
            HttpClientRequest.bodyJsonUnsafe({ query: input.query }),
            HttpClientRequest.setHeader("accept", "application/json"),
          ),
          HindsightReflectResponse,
          { apiKey: settings.apiKey, timeout: REQUEST_TIMEOUT },
        ),
        (response): HindsightReflectResult => ({
          status: statusOf(probed),
          text: response.text,
        }),
      ),
    );

  return HindsightService.of({ listBanks, browse, recall, stats, retain, reflect });
});

export const layer = Layer.effect(HindsightService, make);

/** Unconfigured service, for suites that only need the RPC surface to resolve. */
export const layerTest = Layer.succeed(
  HindsightService,
  HindsightService.of({
    listBanks: () =>
      Effect.succeed({ status: statusOf(NOT_CONFIGURED), banks: [], defaultBank: null }),
    browse: () => Effect.succeed(emptyMemoryResult(NOT_CONFIGURED)),
    recall: () => Effect.succeed(emptyMemoryResult(NOT_CONFIGURED)),
    stats: () => Effect.succeed({ status: statusOf(NOT_CONFIGURED), stats: null }),
    retain: () => Effect.fail(probeFailure(NOT_CONFIGURED)),
    reflect: () => Effect.fail(probeFailure(NOT_CONFIGURED)),
  }),
);
