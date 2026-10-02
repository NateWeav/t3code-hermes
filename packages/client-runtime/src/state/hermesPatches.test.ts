import type { HermesPatch, HermesPatchesSnapshot, HermesPatchId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
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
