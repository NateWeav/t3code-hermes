import type { EnvironmentId, SecretReference } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { useId, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";
import { Label } from "../ui/label";

/** Send the management key once to server secret storage; settings retain only a redaction marker. */
export function AddUsageLimitSourceDialog({
  open,
  onOpenChange,
  environmentId,
  environmentLabel,
  kind = "cliproxy",
  onAdd,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Secret providers are listed from this environment. */
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly kind?: "cliproxy" | "http";
  readonly onAdd: (input: {
    kind: "cliproxy" | "http";
    url: string;
    managementKey: string | SecretReference;
    label: string;
  }) => void;
}) {
  const gt = useGT();
  const formId = useId();
  const [label, setLabel] = useState("");
  const [url, setUrl] = useState("");
  const secretSources = useSecretSources(environmentId);
  const [keyDraft, setKeyDraft] = useState<string | SecretReference>("");
  const [keyValid, setKeyValid] = useState(true);
  const managementKey = typeof keyDraft === "string" ? keyDraft.trim() : keyDraft;
  const trimmedUrl = url.trim();
  const http = kind === "http";
  const endpoint = URL.parse(trimmedUrl);
  const canSave =
    keyValid &&
    (http
      ? endpoint !== null &&
        /^https?:$/.test(endpoint.protocol) &&
        !endpoint.username &&
        !endpoint.password
      : trimmedUrl.length > 0 && managementKey !== "");

  const reset = () => {
    setLabel("");
    setUrl("");
    setKeyDraft("");
    setKeyValid(true);
  };

  const save = () => {
    if (!canSave) return;
    onAdd({ kind, url: trimmedUrl, managementKey, label });
    reset();
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {http ? <T>Add an HTTP quota source</T> : <T>Add a CLIProxyAPI hub</T>}
          </DialogTitle>
          <DialogDescription>
            {http ? (
              <T>
                Read quotas from an endpoint on <Var>{environmentLabel}</Var>.
              </T>
            ) : (
              <>
                Show the quota of every account the hub pools, and resume limited threads when its
                accounts come back. The hub is added to every connected environment you manage, and
                the key stays on their servers.
              </>
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <form
            id={formId}
            className="grid gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              save();
            }}
          >
            <div className="grid gap-1.5">
              <Label htmlFor="usage-source-url">
                {http ? <T>Endpoint URL</T> : <T>Hub URL</T>}
              </Label>
              <Input
                id="usage-source-url"
                placeholder="https://hub.example.ts.net:8318"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                autoFocus
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="usage-source-key">
                {http ? <T>Bearer token (optional)</T> : <T>Management key</T>}
              </Label>
              <SecretSourceInput
                id="usage-source-key"
                aria-label={http ? gt("Bearer token (optional)") : gt("Management key")}
                value={keyDraft}
                sources={secretSources}
                environmentId={environmentId}
                onChange={(event) => setKeyDraft(event.target.value)}
                onSecretChange={(secret) => setKeyDraft(secret ?? "")}
                onValidityChange={setKeyValid}
              />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="usage-source-label">
                <T>Label (optional)</T>
              </Label>
              <Input
                id="usage-source-label"
                placeholder={gt("Defaults to the hub's host name")}
                value={label}
                onChange={(event) => setLabel(event.target.value)}
              />
            </div>
          </form>
        </DialogPanel>
        <DialogFooter variant="bare">
          <Button
            variant="outline"
            onClick={() => {
              reset();
              onOpenChange(false);
            }}
          >
            <T>Cancel</T>
          </Button>
          <Button type="submit" form={formId} disabled={!canSave}>
            {http ? <T>Add source</T> : <T>Add hub</T>}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
