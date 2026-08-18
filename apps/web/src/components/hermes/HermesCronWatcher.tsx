/**
 * Holds the Hermes cron subscription for the lifetime of the sidebar.
 *
 * A component rather than a hook call in `SidebarChromeFooter` so that mounting
 * it stays conditional on Hermes actually being present — an environment
 * without Hermes must not open a subscription it will never use.
 */
import { useHermesCronNotifications } from "./useHermesCronNotifications";

export function HermesCronWatcher() {
  useHermesCronNotifications();
  return null;
}
