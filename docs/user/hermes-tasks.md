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

The Tasks tab lists each task's schedule, latest outcome, and recent run history. Expand a run to
read its message as formatted text and see its delivery target and outcome. Long messages load
when opened, keeping the task list light. If Hermes no longer has the message, the run says so;
an unrecorded delivery outcome does not mean the message was sent.

Each row has two controls, and both are reversible:

- **Pause** stops the task from firing and **Resume** starts it again. This changes the task itself,
  so a paused task stays paused for anything else reading it.
- **Mute** stops notifications about that task without stopping the task. Muting is local to T3 Code
  and only affects what you are told; the task keeps running and its history keeps filling in.

While connected, web and desktop announce new completions with a message preview and an **Open**
action that takes you to that run. They follow the same notification, sound, and focus settings as
chat, including desktop notifications when enabled and permitted. Muted tasks stay quiet. A task
whose runs also appear as threads still notifies once per run, from Tasks, so muting it silences
those threads' run notifications too; your replies in those threads notify as usual. Connecting
later does not replay old notifications; their results remain in history. Mobile shows the messages
in run history, but does not send scheduled-task push notifications.

## Creating a task

Mute is scoped to the environment and shared by all clients connected to it.

There is no form. Tasks are written by Hermes itself, so you create one by asking for it in chat —
"every morning at 9, summarise my open PRs and message me" — and Hermes schedules it. The **New
task…** button at the bottom of the web or desktop panel closes it and starts that sentence for you
in the composer. On mobile, **New task…** copies the same starter sentence; paste it into a Hermes
chat and finish describing the schedule.

Editing and deleting tasks also happens in chat, or through the `hermes` command line.

## Follow runs as threads

Hermes's background work (scheduled jobs and webhook routes, in any Hermes profile) can show up as
threads, so a run reads like work you started in T3 Code. Open **Settings → Integrations → Hermes
runs** to see every job and route Hermes has, and switch on the ones you want. Each switched-on
source sends its runs to the project picked next to it; T3 Code preselects a project when the job's
working directory or the route's config names one.

- A run appears as soon as it uses a tool, and updates live while Hermes works. Runs that finish
  with nothing to report (a final `[SILENT]`) never appear.
- A pull request the run opens is linked to the thread, and the thread settles when that pull
  request merges, like any other thread.
- When a run stops without finishing its job, for example to leave a decision to you, the thread
  stays in your active list with its final report as the last message.
- You can reply once the run has finished. Replies wait while any run of the same job or route is
  still going, so you never race Hermes on the same work. Your first reply starts a new Hermes
  conversation that is given the run's conversation as context. It runs in the Hermes home set on
  your Hermes provider, not in the run's profile.

Switching a source on also brings in its most recent run, so you can check the setup right away.
Switching it off stops new runs from appearing; threads that already exist stay.

The settings live on the environment, so they apply to every device connected to it. Choosing
sources is available on web and desktop; run threads work on mobile like any other thread.

## When the panel is empty

The panel distinguishes between the reasons it has nothing to show. If Hermes is not enabled on the
environment, it says so and points at Settings. If Hermes is enabled but has never been asked for a
task, it explains that tasks are created in chat. If the task list exists but could not be read, it
says that too, rather than showing an empty list that looks like "no tasks".

Run history is stored separately from the task list. If the history is unavailable, the panel still
lists your tasks and shows the latest outcome for each, and tells you that older runs are missing.
