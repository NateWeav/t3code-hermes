/**
 * Hermes patches contract.
 *
 * The fork carries a few patches against Hermes Agent itself (`infra/hermes`)
 * for behaviour T3 Code depends on. They are applied to the user's own git
 * checkout of Hermes, so an update can drop one or leave it no longer fitting
 * without anything saying so. The Patches tab shows where each one stands and
 * applies or removes it.
 *
 * Only patches the environment itself ships can be applied: clients name a
 * patch by id and never send patch content.
 *
 * @module hermesPatches
 */
import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  ForwardCompatibleOptional,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

export const HermesPatchId = TrimmedNonEmptyString.pipe(Schema.brand("HermesPatchId"));
export type HermesPatchId = typeof HermesPatchId.Type;

/**
 * - `applied`: the checkout already contains the change.
 * - `notApplied`: the patch applies cleanly and can be applied now.
 * - `doesNotApply`: it applies in neither direction. `HermesPatch.reason`
 *   says why.
 */
export const HermesPatchState = Schema.Literals(["applied", "notApplied", "doesNotApply"]);
export type HermesPatchState = typeof HermesPatchState.Type;

/**
 * Why a `doesNotApply` patch does not fit, which decides what fixes it:
 * - `hermesTooOld`: the checkout is older than the newest version's Hermes
 *   commit. Updating Hermes fixes it.
 * - `awaitingPatchUpdate`: Hermes has moved past every version. Only a T3 Code
 *   update carrying a rebased version fixes it.
 * - `localChanges`: the checkout has uncommitted edits in files the patch
 *   touches. Neither update helps until they are committed or discarded.
 */
export const HermesPatchMisfitReason = Schema.Literals([
  "hermesTooOld",
  "awaitingPatchUpdate",
  "localChanges",
]);
export type HermesPatchMisfitReason = typeof HermesPatchMisfitReason.Type;

export const HermesPatch = Schema.Struct({
  id: HermesPatchId,
  title: TrimmedNonEmptyString,
  /** What stops working without the patch, in the user's terms. */
  neededFor: TrimmedNonEmptyString,
  state: HermesPatchState,
  /** Set only for `doesNotApply`. Absent from older servers. */
  reason: ForwardCompatibleOptional(HermesPatchMisfitReason),
});
export type HermesPatch = typeof HermesPatch.Type;

/**
 * Whether the environment could inspect a Hermes checkout at all.
 *
 * `notGitCheckout` covers pip, Nix, Docker and package installs: patches apply
 * to a git checkout, the same install shape `hermes update` can update.
 */
export const HermesPatchesAvailability = Schema.Literals([
  "ready",
  "providerDisabled",
  "hermesNotFound",
  "notGitCheckout",
]);
export type HermesPatchesAvailability = typeof HermesPatchesAvailability.Type;

export const HermesPatchesSnapshot = Schema.Struct({
  availability: HermesPatchesAvailability,
  /** The checkout the states describe; null unless `ready`. */
  checkoutPath: Schema.NullOr(TrimmedNonEmptyString),
  /**
   * True when the checkout is on a detached HEAD. `hermes update` cannot move
   * one, so Hermes stays on that commit however often it is updated.
   */
  detachedHead: Schema.Boolean,
  /** The checkout's HEAD, abbreviated. Absent unless `ready`, and from older servers. */
  headCommit: Schema.optionalKey(TrimmedNonEmptyString),
  /**
   * True when `hermesPatchUpdateHermes` can run: a git checkout on a branch.
   * Absent from older servers, which have no such call.
   */
  canUpdateHermes: Schema.optionalKey(Schema.Boolean),
  patches: ForwardCompatibleArray(HermesPatch),
});
export type HermesPatchesSnapshot = typeof HermesPatchesSnapshot.Type;

export const HermesPatchListInput = Schema.Struct({});
export type HermesPatchListInput = typeof HermesPatchListInput.Type;

export const HermesPatchChangeInput = Schema.Struct({
  patchId: HermesPatchId,
});
export type HermesPatchChangeInput = typeof HermesPatchChangeInput.Type;

export const HermesPatchUpdateHermesInput = Schema.Struct({});
export type HermesPatchUpdateHermesInput = typeof HermesPatchUpdateHermesInput.Type;

/**
 * What `hermesPatchUpdateHermes` did: it removes the applied patches, runs
 * `hermes update`, and reapplies them with the version that fits the new HEAD.
 */
export const HermesPatchUpdateHermesResult = Schema.Struct({
  snapshot: HermesPatchesSnapshot,
  /** HEAD before the update, abbreviated; compare with `snapshot.headCommit`. */
  previousHeadCommit: Schema.NullOr(TrimmedNonEmptyString),
  /** `hermes update` exited non-zero or timed out. Patches were still restored where they fit. */
  updateFailed: Schema.Boolean,
  /** The tail of `hermes update`'s output when it failed, else null. */
  failureOutput: Schema.NullOr(Schema.String),
  /** Patches that were applied before and are applied again. */
  reapplied: ForwardCompatibleArray(HermesPatchId),
  /** Previously applied patches no version fits any more; a T3 Code update brings them back. */
  awaitingPatchUpdate: ForwardCompatibleArray(HermesPatchId),
  /** Previously applied patches that could not be reapplied for any other reason. */
  notReapplied: ForwardCompatibleArray(HermesPatchId),
});
export type HermesPatchUpdateHermesResult = typeof HermesPatchUpdateHermesResult.Type;

export class HermesPatchError extends Schema.TaggedError<HermesPatchError>()("HermesPatchError", {
  reason: Schema.Literals(["unavailable", "unknownPatch", "wrongState", "commandFailed"]),
  /** Stable, bounded description. The underlying failure travels in `cause`. */
  detail: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Hermes patch request failed (${this.reason}): ${this.detail}`;
  }
}
