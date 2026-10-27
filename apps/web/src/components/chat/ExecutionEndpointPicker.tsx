import type { ExecutionEndpointId, ExecutionEndpointPresentation } from "@t3tools/contracts";
import { memo, useMemo } from "react";
import { MonitorCogIcon } from "lucide-react";
import { ComposerControlIcon, ComposerSelectControl } from "./ComposerControl";
import { Select, SelectItem, SelectPopup, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { deriveExecutionEndpointOptions } from "./executionEndpointPicker.logic";

export const ExecutionEndpointPicker = memo(function ExecutionEndpointPicker(props: {
  value: ExecutionEndpointId;
  endpoints: Readonly<Record<string, ExecutionEndpointPresentation>>;
  locked: boolean;
  onChange: (endpointId: ExecutionEndpointId) => void;
}) {
  const options = useMemo(() => deriveExecutionEndpointOptions(props.endpoints), [props.endpoints]);
  const selected = options.find((option) => option.id === props.value);
  const label = selected?.label ?? props.value;
  const description = props.locked
    ? `Execution is locked to ${label} for this thread.`
    : (selected?.description ?? `Run the Hermes agent on ${label}.`);

  return (
    <Tooltip>
      <Select
        value={props.value}
        disabled={props.locked}
        onValueChange={(value) => value && props.onChange(value)}
      >
        <TooltipTrigger
          render={
            <ComposerSelectControl
              className="font-medium"
              aria-label="Execution endpoint"
              data-execution-endpoint-locked={props.locked ? "true" : undefined}
            />
          }
        >
          <ComposerControlIcon icon={MonitorCogIcon} />
          <SelectValue>{label}</SelectValue>
        </TooltipTrigger>
        <SelectPopup alignItemWithTrigger={false}>
          {options.map((option) => (
            <SelectItem
              key={option.id}
              value={option.id}
              disabled={option.disabled}
              className="min-w-64 py-2"
            >
              <div className="grid min-w-0 gap-0.5">
                <span className="font-medium text-foreground">{option.label}</span>
                <span className="text-muted-foreground text-xs leading-4">
                  {option.description}
                </span>
              </div>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <TooltipPopup side="top">{description}</TooltipPopup>
    </Tooltip>
  );
});
