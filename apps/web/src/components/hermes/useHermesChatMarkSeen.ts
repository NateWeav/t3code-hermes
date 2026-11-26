import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";

import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";

/**
 * Marks a linked conversation seen for every device, or null when this client
 * may not (a read-only client never clears another device's Done). Unlinked
 * conversations are refused by the server; that is expected, not reported.
 */
export function useHermesChatMarkSeen(
  environmentId: EnvironmentId,
): ((sessionKey: string) => Promise<void>) | null {
  const canOperate = useAtomValue(
    serverEnvironment.hermesChatMarkSeen.permissionAtom(environmentId),
  );
  const markSeen = useAtomCommand(serverEnvironment.hermesChatMarkSeen, {
    label: "hermes conversation mark seen",
    reportFailure: false,
  });
  if (!canOperate) return null;
  return async (sessionKey) => {
    await markSeen({ environmentId, input: { sessionKey } });
  };
}
