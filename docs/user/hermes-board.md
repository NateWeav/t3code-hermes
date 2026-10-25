# See your Hermes Kanban boards

Hermes keeps a Kanban board per project (`hermes kanban boards create <slug>`). The **Board**
surface shows those boards in the right panel, so you can follow a project's milestones without
leaving the thread you are in.

It is read-only for cards. T3 Code reads each board's database directly and never writes to it: moving,
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

## Board icons

Each board can show a T3 project's icon or one you upload. Open a board and select the settings
button in its header:

- **T3 project** links the board to one of this environment's projects, and the board shows that
  project's icon. Pick **None** to unlink. Nothing is linked until you pick one.
- **Upload icon** stores a picture for the board (PNG, JPEG, WebP, GIF or SVG). It is shrunk to
  128 pixels before it is saved, and it wins over the project's icon. **Remove icon** goes back to
  the project's icon.

A board shows its uploaded icon first, then its linked project's icon, then the emoji Hermes gave
it, else no icon. If the linked project is later removed, the board falls back to the emoji.

These are T3 Code settings, saved in `hermes-kanban-boards.json` in the server's state folder and
shared by every client of the environment. Hermes's own files are never changed: a Hermes board's
`project_id` refers to Hermes's projects, not T3 Code's. The settings button only appears for
clients allowed to operate threads.

The board does not update on its own. Use the refresh button in its header to read it again.
