# Watch Hermes scheduled tasks

Hermes can run work on a schedule — a morning digest, a watchdog that checks disk space, a nightly
summary of open pull requests. Those tasks run on the machine Hermes lives on, whether or not you
have T3 Code open. The Hermes panel is where you see them.

The clock button in the web and desktop sidebar footer opens the panel. It appears only on
environments that have Hermes set up. A small dot on the button means a task finished or failed
since you last looked.

On mobile, open **Settings → Hermes**. The row only appears when at least one connected environment
has a Hermes provider instance. If more than one does, choose the environment at the top of the
Tasks tab.

## Tasks

The Tasks tab lists every scheduled task with its schedule, when it last ran, how long that run
took, and a status chip — OK, Failed, or Paused. Expanding a row shows the recent run history and
the reason for the most recent failure, so you can tell a task that is quietly broken from one that
simply has not come due yet.

Each row has two controls, and both are reversible:

- **Pause** stops the task from firing and **Resume** starts it again. This changes the task itself,
  so a paused task stays paused for anything else reading it.
- **Mute** stops notifications about that task without stopping the task. Muting is local to T3 Code
  and only affects what you are told; the task keeps running and its history keeps filling in.

When a task finishes or fails, T3 Code raises a notification and marks the sidebar button, so a
failure overnight is waiting for you rather than lost.

## Creating a task

There is no form. Tasks are written by Hermes itself, so you create one by asking for it in chat —
"every morning at 9, summarise my open PRs and message me" — and Hermes schedules it. The **New
task…** button at the bottom of the web or desktop panel closes it and starts that sentence for you
in the composer. On mobile, **New task…** copies the same starter sentence; paste it into a Hermes
chat and finish describing the schedule.

Editing and deleting tasks also happens in chat, or through the `hermes` command line.

## When the panel is empty

The panel distinguishes between the reasons it has nothing to show. If Hermes is not enabled on the
environment, it says so and points at Settings. If Hermes is enabled but has never been asked for a
task, it explains that tasks are created in chat. If the task list exists but could not be read, it
says that too, rather than showing an empty list that looks like "no tasks".

Run history is stored separately from the task list. If the history is unavailable, the panel still
lists your tasks and shows the latest outcome for each, and tells you that older runs are missing.
