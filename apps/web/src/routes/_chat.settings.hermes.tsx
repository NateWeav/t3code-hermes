import { createFileRoute } from "@tanstack/react-router";
import { HermesSettingsPanel } from "../components/settings/HermesSettings";

export const Route = createFileRoute("/_chat/settings/hermes")({
  component: HermesSettingsPanel,
});
