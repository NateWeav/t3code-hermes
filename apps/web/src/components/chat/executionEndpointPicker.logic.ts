import {
  DEFAULT_EXECUTION_ENDPOINT_ID,
  ExecutionEndpointId,
  type ExecutionEndpointPresentation,
} from "@t3tools/contracts";

export type ExecutionEndpointOption = {
  id: ExecutionEndpointId;
  label: string;
  description: string;
  disabled: boolean;
};

export function deriveExecutionEndpointOptions(
  endpoints: Readonly<Record<string, ExecutionEndpointPresentation>>,
): ExecutionEndpointOption[] {
  return Object.entries(endpoints)
    .map(([id, endpoint]) => ({
      id: ExecutionEndpointId.make(id),
      label: endpoint.displayName,
      description: endpoint.targetLabel,
      disabled: !endpoint.enabled || !endpoint.available,
    }))
    .sort((left, right) => {
      if (left.id === DEFAULT_EXECUTION_ENDPOINT_ID) return -1;
      if (right.id === DEFAULT_EXECUTION_ENDPOINT_ID) return 1;
      return left.label.localeCompare(right.label);
    });
}

export function resolveExecutionEndpointSelection(
  selectedId: ExecutionEndpointId,
  endpoints: Readonly<Record<string, ExecutionEndpointPresentation>>,
  locked = false,
): ExecutionEndpointId {
  if (locked || endpoints[selectedId]) return selectedId;
  if (endpoints[DEFAULT_EXECUTION_ENDPOINT_ID]) return DEFAULT_EXECUTION_ENDPOINT_ID;
  return (
    deriveExecutionEndpointOptions(endpoints).find((endpoint) => !endpoint.disabled)?.id ??
    selectedId
  );
}
