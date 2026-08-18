# Organizing threads

Pin a thread from its context menu to keep it in the pinned section above your active work.
Pinned threads are shown independently of their project, including when you connect to more than
one environment.

On web and desktop, drag a pinned thread to change its position. On mobile, open the thread's menu
and choose **Move up** or **Move down**. The order is stored by the server and appears on your
other connected devices.

If reordering is unavailable for one environment, update the T3 Code server running in that
environment. Older servers can still pin and unpin threads, but do not understand synced ordering;
their pinned threads keep the default newest-first order below the ones you have arranged.

## Status at a glance

Active threads outline their whole card in the same color as the status label inside it, so you can
read a column of threads without reading the labels:

| Outline                | State                                                            |
| ---------------------- | ---------------------------------------------------------------- |
| Blue, dashed, marching | Working — the agent is running                                   |
| Blue, dashed, still    | Monitoring — a watch loop is running with no other live work     |
| Amber, breathing       | Approval — a tool call is waiting on your decision               |
| Indigo, breathing      | Input — the agent asked you a question                           |
| Red, fast pulse        | Failed — the session hit an error                                |
| Green, still           | Done — the agent finished and you have not opened the thread yet |

Settled threads and threads you have already caught up on carry no outline.

To stop the outlines moving, turn off **Thread status animations** in Settings under Appearance.
The outlines and their colors stay; they just hold still. Your system's reduce-motion setting does
the same thing on its own, without changing the setting.

## Environment artwork

Dev and Nightly environments can identify themselves with artwork at the top of the sidebar and in
the send button. Choose **Artwork**, **Version pill**, or **None** in Settings under environment
identification. Artwork is recolored to match each built-in theme. Custom themes use the **Version
pill** fallback because their colors are not controlled by T3 Code.

To generate a fresh title from the conversation, open a thread's context menu and choose
**Regenerate title**. While T3 Code is generating it, the action reads **Regenerating…** and cannot
be selected again. The option is hidden when the connected environment needs a server update.
