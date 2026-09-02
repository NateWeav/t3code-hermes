import {
  DEFAULT_EXECUTION_ENDPOINT_ID,
  ExecutionEndpointId,
  type ExecutionEndpointPresentation,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  deriveExecutionEndpointOptions,
  resolveExecutionEndpointSelection,
} from "./executionEndpointPicker.logic";

const remoteId = ExecutionEndpointId.make("build-host");

const endpoints: Readonly<Record<string, ExecutionEndpointPresentation>> = {
  [remoteId]: {
    kind: "ssh",
    displayName: "Build host",
    enabled: true,
    available: true,
    targetLabel: "SSH endpoint",
    cwd: "/workspace",
  },
  [DEFAULT_EXECUTION_ENDPOINT_ID]: {
    kind: "local",
    displayName: "Local",
    enabled: true,
    available: true,
    targetLabel: "This device",
  },
  offline: {
    kind: "ssh",
    displayName: "Offline host",
    enabled: true,
    available: false,
    targetLabel: "SSH endpoint",
    cwd: "/workspace",
  },
};

describe("execution endpoint picker logic", () => {
  it("keeps Local first and exposes endpoint availability", () => {
    expect(deriveExecutionEndpointOptions(endpoints)).toEqual([
      expect.objectContaining({
        id: DEFAULT_EXECUTION_ENDPOINT_ID,
        label: "Local",
        disabled: false,
      }),
      expect.objectContaining({ id: remoteId, label: "Build host", disabled: false }),
      expect.objectContaining({ id: "offline", label: "Offline host", disabled: true }),
    ]);
  });

  it("falls back to Local when a draft selection is no longer configured", () => {
    expect(resolveExecutionEndpointSelection(ExecutionEndpointId.make("removed"), endpoints)).toBe(
      DEFAULT_EXECUTION_ENDPOINT_ID,
    );
  });

  it("preserves an existing thread endpoint even when it is no longer selectable", () => {
    const removedId = ExecutionEndpointId.make("removed");
    expect(resolveExecutionEndpointSelection(removedId, endpoints, true)).toBe(removedId);
  });
});
