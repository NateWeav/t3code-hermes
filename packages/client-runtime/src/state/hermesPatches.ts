/**
 * Wording for the Hermes Patches tab, shared by web and mobile.
 *
 * @module state/hermesPatches
 */
import type {
  HermesGatewayStatus,
  HermesPatchState,
  HermesPatchesSnapshot,
} from "@t3tools/contracts";

export const HERMES_PATCH_STATE_LABELS: Record<HermesPatchState, string> = {
  applied: "Applied",
  notApplied: "Not applied",
  doesNotApply: "Doesn't apply",
};

/** One line under a patch saying what its state means for the user. */
export const HERMES_PATCH_STATE_HINTS: Record<HermesPatchState, string> = {
  applied: "Hermes has this change. New Hermes sessions use it.",
  notApplied: "Applies cleanly. Hermes does not have this change yet.",
  doesNotApply:
    "Made for a different Hermes version. Update Hermes; if it still doesn't apply, the patch needs a rebase in T3 Code.",
};

/** Why there is nothing to show, or null when the checkout was read. */
export function describeHermesPatchesUnavailable(
  snapshot: HermesPatchesSnapshot,
): { readonly title: string; readonly description: string } | null {
  switch (snapshot.availability) {
    case "ready":
      return null;
    case "providerDisabled":
      return {
        title: "Hermes is not enabled",
        description: "Enable the Hermes provider in this environment to manage its patches.",
      };
    case "hermesNotFound":
      return {
        title: "Hermes was not found",
        description: "The Hermes binary configured for this environment could not be found.",
      };
    case "notGitCheckout":
      return {
        title: "Hermes is not a git checkout",
        description:
          "Patches apply to a git checkout of Hermes. This install came from a package manager or image, so its patches have to come from there.",
      };
  }
}

/**
 * What to say about the Hermes gateway, or null when there is nothing to do:
 * no gateway is running, or it already runs the current code. `restart` says
 * whether to offer the restart button.
 */
export function describeHermesGateway(
  gateway: HermesGatewayStatus | null,
  restartFailure: string | null,
): { readonly tone: "warning" | "info"; readonly text: string; readonly restart: boolean } | null {
  if (gateway === null) return null;
  if (gateway.state === "restarting") {
    return {
      tone: "info",
      text: "Restarting the Hermes gateway. It finishes the chats, tasks, and webhook runs it is working on first.",
      restart: false,
    };
  }
  if (restartFailure !== null) {
    return {
      tone: "warning",
      text: `The gateway restart failed: ${restartFailure}`,
      restart: gateway.canRestart,
    };
  }
  if (gateway.state === "upToDate") return null;
  if (!gateway.canRestart) {
    return {
      tone: "warning",
      text: "The Hermes gateway is running code from before these changes. It does not run as a service, so restart it where it was started.",
      restart: false,
    };
  }
  return {
    tone: "warning",
    text: "The Hermes gateway is running code from before these changes. Restart it so messaging, scheduled tasks, and webhooks use them.",
    restart: true,
  };
}

// Plain text on both clients, so no markdown quoting.
export const HERMES_DETACHED_HEAD_WARNING =
  "This Hermes checkout is on a detached HEAD, so updating Hermes cannot move it. Check out main in the checkout, then update.";

/** The server's reason when it gave one, else a generic line. */
export function describeHermesPatchFailure(failure: unknown, fallback: string): string {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    failure._tag === "HermesPatchError" &&
    "detail" in failure &&
    typeof failure.detail === "string"
  ) {
    return failure.detail;
  }
  return fallback;
}
