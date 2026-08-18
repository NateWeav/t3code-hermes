import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  HINDSIGHT_CONTRACT_VERSION,
  HINDSIGHT_MAX_NOTE_LENGTH,
  HINDSIGHT_TARGET_API_VERSION,
  HindsightBankId,
  HindsightBanksResult,
  HindsightBrowseInput,
  HindsightMemoryResult,
  HindsightRecallInput,
  HindsightReflectInput,
  HindsightRetainInput,
  HindsightStatsInput,
  HindsightStatsResult,
  type HindsightStatus,
} from "./hindsight.ts";

const decodeMemoryResult = Schema.decodeUnknownSync(HindsightMemoryResult);
const encodeMemoryResult = Schema.encodeSync(HindsightMemoryResult);
const decodeBanksResult = Schema.decodeUnknownSync(HindsightBanksResult);
const encodeBanksResult = Schema.encodeSync(HindsightBanksResult);
const decodeBrowseInput = Schema.decodeUnknownSync(HindsightBrowseInput);
const decodeRecallInput = Schema.decodeUnknownSync(HindsightRecallInput);
const decodeRetainInput = Schema.decodeUnknownSync(HindsightRetainInput);
const decodeReflectInput = Schema.decodeUnknownSync(HindsightReflectInput);
const decodeStatsInput = Schema.decodeUnknownSync(HindsightStatsInput);
const decodeStatsResult = Schema.decodeUnknownSync(HindsightStatsResult);
const encodeStatsResult = Schema.encodeSync(HindsightStatsResult);

const decodeBankId = Schema.decodeUnknownSync(HindsightBankId);

const BANK = decodeBankId("hermes");

const READY: HindsightStatus = {
  contractVersion: HINDSIGHT_CONTRACT_VERSION,
  availability: "ready",
  detail: null,
  apiVersion: "0.9.1",
  targetApiVersion: HINDSIGHT_TARGET_API_VERSION,
};

const MEMORY_RESULT = {
  status: READY,
  memories: [
    {
      id: "6f1d0b6e-2f7a-4a2e-9f1a-000000000001",
      pathway: "world" as const,
      text: "T3 Code's server runs TypeScript directly under Node 24.",
      context: "Learned while reading FORK.md",
      title: null,
      rememberedAt: "2026-08-14T11:00:00Z",
      confidence: 0.82,
      entities: ["T3 Code", "Node"],
      tags: ["t3code"],
    },
    {
      id: "mm-1",
      pathway: "mentalModel" as const,
      text: "Merge-based, never rebase.",
      context: null,
      title: "How this fork tracks upstream",
      rememberedAt: null,
      confidence: null,
      entities: [],
      tags: [],
    },
  ],
  hasMore: true,
};

describe("hindsight contract", () => {
  it("round-trips a memory result", () => {
    const decoded = decodeMemoryResult(MEMORY_RESULT);
    expect(encodeMemoryResult(decoded)).toEqual(MEMORY_RESULT);
  });

  it("round-trips a banks result", () => {
    const banksResult = {
      status: READY,
      banks: [
        { id: BANK, name: "Hermes", factCount: 128 },
        { id: decodeBankId("scratch"), name: null, factCount: 0 },
      ],
      defaultBank: BANK,
    };
    const decoded = decodeBanksResult(banksResult);
    expect(encodeBanksResult(decoded)).toEqual(banksResult);
  });

  it("keeps unknown memories out of the list rather than failing the whole page", () => {
    // ForwardCompatibleArray: an environment on a newer contract can send a
    // pathway this build does not know, and the rest of the page still renders.
    const decoded = decodeMemoryResult({
      ...MEMORY_RESULT,
      memories: [...MEMORY_RESULT.memories, { id: "x", pathway: "dreams", text: "?" }],
    });
    expect(decoded.memories).toHaveLength(2);
  });

  it("accepts every non-ready availability", () => {
    for (const availability of [
      "notConfigured",
      "offline",
      "incompatible",
      "requestFailed",
    ] as const) {
      const decoded = decodeMemoryResult({
        status: { ...READY, availability, detail: "why", apiVersion: null },
        memories: [],
        hasMore: false,
      });
      expect(decoded.status.availability).toBe(availability);
      expect(decoded.memories).toEqual([]);
    }
  });

  it("decodes the read inputs", () => {
    expect(decodeBrowseInput({ bank: "hermes", pathway: "all" })).toEqual({
      bank: BANK,
      pathway: "all",
    });
    expect(decodeBrowseInput({ bank: "hermes", pathway: "mentalModel", limit: 10 }).limit).toBe(10);
    expect(decodeRecallInput({ bank: "hermes", pathway: "world", query: "node" }).query).toBe(
      "node",
    );
  });

  it("rejects an empty recall query", () => {
    expect(() => decodeRecallInput({ bank: "hermes", pathway: "all", query: "   " })).toThrow();
  });

  it("rejects an empty or oversized note", () => {
    expect(() => decodeRetainInput({ bank: "hermes", text: "  " })).toThrow();
    expect(() =>
      decodeRetainInput({ bank: "hermes", text: "x".repeat(HINDSIGHT_MAX_NOTE_LENGTH + 1) }),
    ).toThrow();
    expect(decodeRetainInput({ bank: "hermes", text: " remember this " }).text).toBe(
      "remember this",
    );
  });

  it("rejects a reflect with no query", () => {
    expect(() => decodeReflectInput({ bank: "hermes", query: "" })).toThrow();
  });

  it("round-trips bank statistics", () => {
    const statsResult = {
      status: READY,
      stats: {
        nodes: 128,
        links: 342,
        documents: 17,
        nodesByPathway: [
          { pathway: "world" as const, count: 80 },
          { pathway: "experience" as const, count: 40 },
        ],
        pendingOperations: 2,
        failedOperations: 1,
        lastConsolidatedAt: "2026-08-15T17:45:00Z",
      },
    };
    const decoded = decodeStatsResult(statsResult);
    expect(encodeStatsResult(decoded)).toEqual(statsResult);
    expect(decodeStatsInput({ bank: "hermes" })).toEqual({ bank: BANK });
  });

  it("carries null stats for a Hindsight that could not count", () => {
    // Null rather than zeroes: "0 memories" and "we could not ask" are
    // different claims, and only one of them is safe to render.
    const decoded = decodeStatsResult({
      status: { ...READY, availability: "requestFailed", detail: "why" },
      stats: null,
    });
    expect(decoded.stats).toBeNull();
  });

  it("drops a pathway count this build does not know rather than failing the strip", () => {
    const decoded = decodeStatsResult({
      status: READY,
      stats: {
        nodes: 5,
        links: 0,
        documents: 0,
        nodesByPathway: [
          { pathway: "world", count: 5 },
          { pathway: "dreams", count: 3 },
        ],
        pendingOperations: 0,
        failedOperations: 0,
        lastConsolidatedAt: null,
      },
    });
    expect(decoded.stats?.nodesByPathway).toHaveLength(1);
  });

  it("rejects a status from a contract version this build does not speak", () => {
    expect(() =>
      decodeMemoryResult({
        status: { ...READY, contractVersion: HINDSIGHT_CONTRACT_VERSION + 1 },
        memories: [],
        hasMore: false,
      }),
    ).toThrow();
  });
});
