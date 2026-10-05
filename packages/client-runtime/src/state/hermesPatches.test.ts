import type { HermesPatch, HermesPatchesSnapshot, HermesPatchId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  describeHermesGateway,
  describeHermesPatchHint,
  describeHermesUpdateResult,
  HERMES_PATCH_STATE_HINTS,
  shouldOfferHermesUpdate,
} from "./hermesPatches.ts";

const patch = (id: string, overrides: Partial<HermesPatch> = {}): HermesPatch => ({
  id: id as HermesPatchId,
  title: `Title ${id}`,
  neededFor: "Tests.",
  state: "doesNotApply",
  ...overrides,
});

const snapshot = (overrides: Partial<HermesPatchesSnapshot> = {}): HermesPatchesSnapshot => ({
  availability: "ready",
  checkoutPath: "/hermes",
  detachedHead: false,
  headCommit: "bbbbbbb",
  canUpdateHermes: true,
  patches: [],
  gateway: null,
  gatewayRestartFailure: null,
  ...overrides,
});

describe("Hermes patch wording", () => {
  it("explains a misfit by its reason, and falls back for older servers", () => {
    expect(describeHermesPatchHint(patch("a", { reason: "localChanges" }))).toContain(
      "Local changes",
    );
    expect(describeHermesPatchHint(patch("a"))).toBe(HERMES_PATCH_STATE_HINTS.doesNotApply);
  });

  it("offers Update Hermes only when it can run and would make a patch fit", () => {
    const tooOld = patch("a", { reason: "hermesTooOld" });
    expect(shouldOfferHermesUpdate(snapshot({ patches: [tooOld] }))).toBe(true);
    expect(shouldOfferHermesUpdate(snapshot({ patches: [tooOld], canUpdateHermes: false }))).toBe(
      false,
    );
    // An older server sends no capability at all.
    const { canUpdateHermes: _, ...older } = snapshot({ patches: [tooOld] });
    expect(shouldOfferHermesUpdate(older)).toBe(false);
    expect(
      shouldOfferHermesUpdate(
        snapshot({ patches: [patch("a", { reason: "awaitingPatchUpdate" })] }),
      ),
    ).toBe(false);
  });

  it("summarizes an update by what happened to each patch", () => {
    const patches = [
      patch("a", { state: "applied" }),
      patch("b", { reason: "awaitingPatchUpdate" }),
    ];
    const base = {
      snapshot: snapshot({ patches }),
      previousHeadCommit: "aaaaaaa",
      updateFailed: false,
      failureOutput: null,
      notReapplied: [],
    };
    expect(
      describeHermesUpdateResult({
        ...base,
        reapplied: ["a" as HermesPatchId],
        awaitingPatchUpdate: ["b" as HermesPatchId],
      }),
    ).toBe("Hermes updated to bbbbbbb. Reapplied: Title a. Waiting for a T3 Code update: Title b.");
    expect(
      describeHermesUpdateResult({
        ...base,
        previousHeadCommit: "bbbbbbb",
        reapplied: [],
        awaitingPatchUpdate: [],
      }),
    ).toBe("Hermes was already up to date.");
    expect(
      describeHermesUpdateResult({
        ...base,
        updateFailed: true,
        failureOutput: "Fetching…\nnetwork unreachable\n",
        reapplied: ["a" as HermesPatchId],
        awaitingPatchUpdate: [],
      }),
    ).toBe("Hermes could not be updated: network unreachable. Reapplied: Title a.");
  });
});

describe("describeHermesGateway", () => {
  it("stays quiet when no gateway runs or it already has the changes", () => {
    expect(describeHermesGateway(null, null)).toBeNull();
    expect(describeHermesGateway({ state: "upToDate", canRestart: true }, null)).toBeNull();
  });

  it("offers a restart only for an outdated gateway that runs as a service", () => {
    expect(describeHermesGateway({ state: "outdated", canRestart: true }, null)?.restart).toBe(
      true,
    );
    expect(describeHermesGateway({ state: "outdated", canRestart: false }, null)?.restart).toBe(
      false,
    );
  });

  it("shows a running restart without a button, and a failed one with a retry", () => {
    expect(describeHermesGateway({ state: "restarting", canRestart: true }, null)).toMatchObject({
      tone: "info",
      restart: false,
    });
    // The old gateway still answers after a failed restart, however its age compares.
    expect(
      describeHermesGateway({ state: "upToDate", canRestart: true }, "exited with code 1."),
    ).toMatchObject({
      tone: "warning",
      text: "The gateway restart failed: exited with code 1.",
      restart: true,
    });
  });

  it("keeps a failed restart visible after the gateway stopped and did not come back", () => {
    expect(describeHermesGateway(null, "The gateway stopped and did not come back.")).toMatchObject(
      {
        tone: "warning",
        text: "The gateway restart failed: The gateway stopped and did not come back.",
        restart: false,
      },
    );
  });
});
