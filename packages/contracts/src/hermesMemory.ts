import * as Schema from "effect/Schema";

/** Built-in Hermes files, independent of the optional Hindsight service. */
export const HermesMemoryTarget = Schema.Literals(["memory", "user"]);
export type HermesMemoryTarget = typeof HermesMemoryTarget.Type;

export const HermesMemoryFile = Schema.Struct({
  target: HermesMemoryTarget,
  entries: Schema.Array(Schema.String),
  charsUsed: Schema.Number,
  charLimit: Schema.Number,
  /** Opaque store identity and content hash. Stale views are rejected under Hermes's file lock. */
  revision: Schema.String,
  /** Unreadable or non-roundtripping files remain visible but cannot be edited. */
  error: Schema.NullOr(Schema.String),
});
export type HermesMemoryFile = typeof HermesMemoryFile.Type;

export const HermesMemorySnapshot = Schema.Struct({
  availability: Schema.Literals(["ready", "providerDisabled", "unreadable"]),
  detail: Schema.NullOr(Schema.String),
  files: Schema.Array(HermesMemoryFile),
});
export type HermesMemorySnapshot = typeof HermesMemorySnapshot.Type;

const mutationBase = { target: HermesMemoryTarget, revision: Schema.String };
export const HermesMemoryMutateInput = Schema.Union([
  Schema.Struct({ ...mutationBase, action: Schema.Literal("add"), content: Schema.String }),
  Schema.Struct({
    ...mutationBase,
    action: Schema.Literal("replace"),
    oldText: Schema.String,
    content: Schema.String,
  }),
  Schema.Struct({ ...mutationBase, action: Schema.Literal("remove"), oldText: Schema.String }),
]);
export type HermesMemoryMutateInput = typeof HermesMemoryMutateInput.Type;
export const HermesMemoryReadInput = Schema.Struct({});
export const HermesMemorySubscribeInput = Schema.Struct({});

export class HermesMemoryError extends Schema.TaggedError<HermesMemoryError>()(
  "HermesMemoryError",
  {
    reason: Schema.Literals([
      "providerDisabled",
      "unreadable",
      "conflict",
      "invalidContent",
      "capacity",
      "writeFailed",
    ]),
    /** Stable, user-safe description. The underlying failure travels in `cause`. */
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return this.detail;
  }
}

/** Match Python text-file newlines and str.strip so client capacity previews
 * count exactly the content the built-in memory store will persist. */
export function normalizeHermesMemoryEntry(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/^[\p{White_Space}\u001c-\u001f]+|[\p{White_Space}\u001c-\u001f]+$/gu, "");
}
