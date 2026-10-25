# See your Hermes Kanban boards

Hermes keeps a Kanban board per project (`hermes kanban boards create <slug>`). The **Board**
surface shows those boards in the right panel, so you can follow a project's milestones without
leaving the thread you are in.

It is read-only. T3 Code reads each board's database directly and never writes to it: moving,
completing, or commenting on a card still happens through Hermes (`hermes kanban …`, or by asking
the agent).

## Open the board

From a thread, open the right panel's **Open a surface** list and choose **Board** (shortcut `K`),
or run **Open Board** from the command palette. The surface needs the Hermes provider turned on in
Settings.

## What it shows

- **Overview.** One card per board: its icon and color, description, a progress bar of done cards
  over all cards, running and blocked counts, and when it last changed. Boards with blocked cards
  come first, then the most recently touched. Archived boards are left out, and the legacy
  `default` board appears only once it holds a card.
- **Milestones.** Select a board to see each feature card with its milestones and their progress.
  A milestone is a card the feature waits on (`hermes kanban link <milestone> <feature>`). Cards
  that are neither a feature nor a milestone are listed below as **Cards**.
- **Columns.** The toggle in the board's header shows the same cards in four columns: To do
  (triage, todo, scheduled, ready), In progress (running, review), Blocked, and Done. A status a
  newer Hermes adds lands in an extra **Other** column rather than going missing.
- **A card.** Select any card for its status, body, result, timestamps, and comments.

Body lines Hermes leaves as plain text become links on the card:

```text
PR: https://github.com/owner/repo/pull/42
Branch: feat/my-feature
T3-Thread: t3-thread://v1/<thread id>
```

The PR chip opens the pull request, and the thread chip opens the T3 Code thread.

The board does not update on its own. Use the refresh button in its header to read it again.
