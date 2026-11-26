import { useEffect, useEffectEvent } from "react";

const LIVE_REFRESH_MS = 5_000;

/**
 * Rereads every few seconds while mounted. A hidden tab skips its ticks and a
 * read still in flight is never doubled, so a slow store cannot pile reads up.
 */
export function useHermesChatLiveRefresh(query: {
  readonly refresh: () => void;
  readonly isPending: boolean;
}) {
  const tick = useEffectEvent(() => {
    if (document.visibilityState === "visible" && !query.isPending) query.refresh();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- interval timer that refreshes the Hermes chat query while mounted
  useEffect(() => {
    const timer = setInterval(tick, LIVE_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
}
