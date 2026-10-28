/** Mounts a Hermes Tasks alert watcher per environment, sharing the thread notification badge. */
import { useEnvironmentIdentities } from "../../state/environments";
import { reportNotificationAttention } from "../ThreadNotificationCoordinator";
import { HermesCronWatcher } from "./HermesCronWatcher";

export function HermesCronNotifications() {
  const environmentIds = useEnvironmentIdentities().map((identity) => identity.environmentId);
  return environmentIds.map((environmentId) => (
    <HermesCronWatcher
      key={environmentId}
      environmentId={environmentId}
      onAttention={reportNotificationAttention}
    />
  ));
}
