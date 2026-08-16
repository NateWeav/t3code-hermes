/**
 * Provider-reported subscription quota windows.
 *
 * This is intentionally separate from transcript-derived token/cost usage:
 * subscription capacity is not spend, and providers define their own rolling
 * windows and reset schedules.
 *
 * @module providerQuota
 */
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const PROVIDER_QUOTA_CONTRACT_VERSION = 1 as const;

export const ProviderQuotaStatus = Schema.Literals([
  "ok",
  "setupRequired",
  "unavailable",
  "failed",
]);
export type ProviderQuotaStatus = typeof ProviderQuotaStatus.Type;

export const ProviderQuotaSource = Schema.Literals(["cli", "oauth", "api", "web", "local"]);
export type ProviderQuotaSource = typeof ProviderQuotaSource.Type;

export const ProviderQuotaWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.NullOr(Schema.String),
  durationMinutes: Schema.NullOr(Schema.Number.check(Schema.isGreaterThan(0))),
});
export type ProviderQuotaWindow = typeof ProviderQuotaWindow.Type;

export const ProviderQuotaAccount = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  provider: ProviderDriverKind,
  displayName: TrimmedNonEmptyString,
  accountLabel: Schema.NullOr(TrimmedNonEmptyString),
  planLabel: Schema.NullOr(TrimmedNonEmptyString),
  source: Schema.NullOr(ProviderQuotaSource),
  status: ProviderQuotaStatus,
  windows: Schema.Array(ProviderQuotaWindow),
  observedAt: Schema.String,
  message: Schema.NullOr(TrimmedNonEmptyString),
});
export type ProviderQuotaAccount = typeof ProviderQuotaAccount.Type;

export const ProviderQuotaSummary = Schema.Struct({
  contractVersion: Schema.Literal(PROVIDER_QUOTA_CONTRACT_VERSION),
  readAt: Schema.String,
  accounts: Schema.Array(ProviderQuotaAccount),
});
export type ProviderQuotaSummary = typeof ProviderQuotaSummary.Type;

export class ProviderQuotaReadError extends Schema.TaggedErrorClass<ProviderQuotaReadError>()(
  "ProviderQuotaReadError",
  {
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider quota read failed: ${this.detail}`;
  }
}
