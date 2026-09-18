import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { PortSchema, TrimmedNonEmptyString } from "./baseSchemas.ts";

const NoControlCharacters = Schema.makeFilter(
  (value: string) => !/[\u0000-\u001f\u007f]/.test(value) || "Control characters are not allowed.",
);
const NotOptionLike = Schema.makeFilter(
  (value: string) => !value.startsWith("-") || "Values beginning with '-' are not allowed.",
);
const AbsolutePath = Schema.makeFilter(
  (value: string) => /^(?:\/|[A-Za-z]:[\\/])/.test(value) || "An absolute path is required.",
);
const SafeEndpointText = TrimmedNonEmptyString.check(NoControlCharacters);
const SafeSshTargetPart = SafeEndpointText.check(NotOptionLike);
const AbsoluteEndpointPath = SafeEndpointText.check(AbsolutePath);

export const ExecutionEndpointId = TrimmedNonEmptyString.pipe(Schema.brand("ExecutionEndpointId"));
export type ExecutionEndpointId = typeof ExecutionEndpointId.Type;

export const DEFAULT_EXECUTION_ENDPOINT_ID = ExecutionEndpointId.make("local");

export const LocalExecutionEndpointConfig = Schema.Struct({
  kind: Schema.Literal("local"),
  displayName: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export type LocalExecutionEndpointConfig = typeof LocalExecutionEndpointConfig.Type;

export const SshExecutionEndpointConfig = Schema.Struct({
  kind: Schema.Literal("ssh"),
  displayName: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  host: SafeSshTargetPart,
  user: SafeSshTargetPart,
  port: PortSchema.pipe(Schema.withDecodingDefault(Effect.succeed(22))),
  identityFile: AbsoluteEndpointPath,
  cwd: AbsoluteEndpointPath,
  syncFiles: Schema.Literal(false).pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  persistentShell: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type SshExecutionEndpointConfig = typeof SshExecutionEndpointConfig.Type;

export const ExecutionEndpointConfig = Schema.Union([
  LocalExecutionEndpointConfig,
  SshExecutionEndpointConfig,
]);
export type ExecutionEndpointConfig = typeof ExecutionEndpointConfig.Type;

export const DEFAULT_EXECUTION_ENDPOINTS: Readonly<
  Record<ExecutionEndpointId, ExecutionEndpointConfig>
> = {
  [DEFAULT_EXECUTION_ENDPOINT_ID]: { kind: "local", displayName: "Local", enabled: true },
};

export const ExecutionEndpointPresentation = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("local"),
    displayName: TrimmedNonEmptyString,
    enabled: Schema.Boolean,
    available: Schema.Boolean,
    targetLabel: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    kind: Schema.Literal("ssh"),
    displayName: TrimmedNonEmptyString,
    enabled: Schema.Boolean,
    available: Schema.Boolean,
    targetLabel: TrimmedNonEmptyString,
    cwd: TrimmedNonEmptyString,
  }),
]);
export type ExecutionEndpointPresentation = typeof ExecutionEndpointPresentation.Type;

export const SshExecutionEndpointUpsert = Schema.Struct({
  displayName: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  host: SafeSshTargetPart,
  user: SafeSshTargetPart,
  port: PortSchema.pipe(Schema.withDecodingDefault(Effect.succeed(22))),
  identityFile: Schema.optionalKey(AbsoluteEndpointPath),
  cwd: AbsoluteEndpointPath,
});
export type SshExecutionEndpointUpsert = typeof SshExecutionEndpointUpsert.Type;

export const ExecutionEndpointUpsertInput = Schema.Struct({
  endpointId: ExecutionEndpointId,
  endpoint: SshExecutionEndpointUpsert,
});
export type ExecutionEndpointUpsertInput = typeof ExecutionEndpointUpsertInput.Type;

export const ExecutionEndpointRemoveInput = Schema.Struct({ endpointId: ExecutionEndpointId });
export type ExecutionEndpointRemoveInput = typeof ExecutionEndpointRemoveInput.Type;

export const presentExecutionEndpoint = (
  endpoint: ExecutionEndpointConfig,
): ExecutionEndpointPresentation =>
  endpoint.kind === "local"
    ? {
        kind: "local",
        displayName: endpoint.displayName,
        enabled: endpoint.enabled,
        available: endpoint.enabled,
        targetLabel: "This device",
      }
    : {
        kind: "ssh",
        displayName: endpoint.displayName,
        enabled: endpoint.enabled,
        available: endpoint.enabled,
        targetLabel: "SSH endpoint",
        cwd: endpoint.cwd,
      };
