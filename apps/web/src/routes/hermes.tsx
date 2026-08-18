import { createFileRoute } from "@tanstack/react-router";

import { HermesPanel } from "../components/hermes/HermesPanel";

export const Route = createFileRoute("/hermes")({ component: HermesPanel });
