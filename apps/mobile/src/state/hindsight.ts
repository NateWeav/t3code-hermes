import { HINDSIGHT_DEFAULT_REFLECT_QUERY } from "@t3tools/client-runtime/state/hindsight";
import type {
  EnvironmentId,
  HindsightBank,
  HindsightBankId,
  HindsightBankStats,
  HindsightMemory,
  HindsightPathwayFilter,
  HindsightStatus,
} from "@t3tools/contracts";
import { useCallback, useMemo, useState } from "react";

import { useEnvironmentQuery } from "./query";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

export interface HindsightMemoryState {
  readonly status: HindsightStatus | null;
  readonly banks: ReadonlyArray<HindsightBank>;
  readonly bank: HindsightBankId | null;
  readonly pathway: HindsightPathwayFilter;
  readonly submittedQuery: string;
  readonly memories: ReadonlyArray<HindsightMemory>;
  readonly hasMore: boolean;
  /** Bank counts, or null when unread or unreadable. Never zeroes for unknown. */
  readonly stats: HindsightBankStats | null;
  readonly isStatsPending: boolean;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly reflection: string | null;
  readonly isReflecting: boolean;
  readonly isRetaining: boolean;
}

export interface HindsightRetainSuccess {
  readonly itemsCount: number;
}

export function useHindsightMemory(environmentId: EnvironmentId | null) {
  const [selectedBank, setSelectedBank] = useState<HindsightBankId | null>(null);
  const [pathway, setPathway] = useState<HindsightPathwayFilter>("all");
  const [submittedQuery, setSubmittedQuery] = useState("");
  const [reflection, setReflection] = useState<string | null>(null);
  const [isReflecting, setIsReflecting] = useState(false);
  const [isRetaining, setIsRetaining] = useState(false);

  const banksQuery = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.hindsightBanks({ environmentId, input: {} }),
  );
  const banks = banksQuery.data?.banks ?? [];
  const bank =
    selectedBank !== null && banks.some((candidate) => candidate.id === selectedBank)
      ? selectedBank
      : (banksQuery.data?.defaultBank ?? banks[0]?.id ?? null);
  const isRecalling = submittedQuery.length > 0;

  const browseQuery = useEnvironmentQuery(
    environmentId === null || bank === null || isRecalling
      ? null
      : serverEnvironment.hindsightBrowse({ environmentId, input: { bank, pathway } }),
  );
  const recallQuery = useEnvironmentQuery(
    environmentId === null || bank === null || !isRecalling
      ? null
      : serverEnvironment.hindsightRecall({
          environmentId,
          input: { bank, pathway, query: submittedQuery },
        }),
  );
  // Counts belong to the bank, not the query, so browse/recall leaves them be.
  const statsQuery = useEnvironmentQuery(
    environmentId === null || bank === null
      ? null
      : serverEnvironment.hindsightStats({ environmentId, input: { bank } }),
  );
  const activeQuery = isRecalling ? recallQuery : browseQuery;
  const status = activeQuery.data?.status ?? banksQuery.data?.status ?? null;

  const retainCommand = useAtomCommand(serverEnvironment.hindsightRetain, { reportFailure: false });
  const reflectCommand = useAtomCommand(serverEnvironment.hindsightReflect, {
    reportFailure: false,
  });

  const retry = useCallback(() => {
    banksQuery.refresh();
    browseQuery.refresh();
    recallQuery.refresh();
    statsQuery.refresh();
  }, [banksQuery.refresh, browseQuery.refresh, recallQuery.refresh, statsQuery.refresh]);
  const submitQuery = useCallback((query: string) => setSubmittedQuery(query.trim()), []);
  const clearQuery = useCallback(() => setSubmittedQuery(""), []);
  const selectBank = useCallback((next: HindsightBankId) => {
    setSelectedBank(next);
    setReflection(null);
  }, []);

  const retain = useCallback(
    async (text: string): Promise<HindsightRetainSuccess | null> => {
      const trimmed = text.trim();
      if (environmentId === null || bank === null || trimmed.length === 0) return null;
      setIsRetaining(true);
      try {
        const result = await retainCommand({ environmentId, input: { bank, text: trimmed } });
        if (result._tag !== "Success") return null;
        retry();
        return { itemsCount: result.value.itemsCount };
      } finally {
        setIsRetaining(false);
      }
    },
    [bank, environmentId, retainCommand, retry],
  );

  const reflect = useCallback(async (): Promise<string | null> => {
    if (environmentId === null || bank === null || isReflecting) return null;
    setIsReflecting(true);
    try {
      const query = submittedQuery.length > 0 ? submittedQuery : HINDSIGHT_DEFAULT_REFLECT_QUERY;
      const result = await reflectCommand({ environmentId, input: { bank, query } });
      if (result._tag !== "Success") return null;
      setReflection(result.value.text);
      // Reflecting writes mental models and can consolidate, so the counts move.
      statsQuery.refresh();
      return result.value.text;
    } finally {
      setIsReflecting(false);
    }
  }, [bank, environmentId, isReflecting, reflectCommand, statsQuery.refresh, submittedQuery]);

  const memories = activeQuery.data?.memories ?? [];
  return useMemo(
    () => ({
      status,
      banks,
      bank,
      pathway,
      submittedQuery,
      memories,
      hasMore: activeQuery.data?.hasMore ?? false,
      // A failed stats read answers with `stats: null`, so the strip vanishes
      // and the list beside it is untouched.
      stats: statsQuery.data?.stats ?? null,
      isStatsPending: bank !== null && statsQuery.data === null && statsQuery.error === null,
      isPending: (banksQuery.isPending || activeQuery.isPending) && activeQuery.data === null,
      error: activeQuery.error ?? banksQuery.error,
      reflection,
      isReflecting,
      isRetaining,
      selectBank,
      selectPathway: setPathway,
      submitQuery,
      clearQuery,
      retry,
      retain,
      reflect,
      dismissReflection: () => setReflection(null),
    }),
    [
      activeQuery.data,
      activeQuery.error,
      activeQuery.isPending,
      bank,
      banks,
      banksQuery.error,
      banksQuery.isPending,
      clearQuery,
      isReflecting,
      isRetaining,
      memories,
      pathway,
      reflect,
      reflection,
      retain,
      retry,
      selectBank,
      status,
      statsQuery.data,
      statsQuery.error,
      submitQuery,
      submittedQuery,
    ],
  );
}
