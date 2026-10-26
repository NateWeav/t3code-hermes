import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { WORKING_EXIT_GRACE_MS } from "@t3tools/client-runtime/state/thread-inbox";
import type { AnyRouter } from "@tanstack/react-router";
import { HermesCronJobId, type HermesCronRunCompleted } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { fakeTimers, render, stubGlobal, type Screen } from "../../test/render";

// Hermes Tasks alerts render per environment and share the thread notification service's badge.
const state = vi.hoisted(() => ({
  mode: "notifications",
  inApp: false,
  dots: false,
  toast: vi.fn(),
  shells: null as unknown as { set: (id: string, value: unknown) => void },
  navigate: vi.fn(),
  sound: vi.fn(),
  badge: vi.fn(),
  settingsListeners: new Set<() => void>(),
  hermes: null as unknown as { set: (id: string, value: HermesCronRunCompleted | null) => void },
  location: { pathname: "/", search: {} as Record<string, string> },
  reportHermes: vi.fn(),
  markHermesSeen: vi.fn(),
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
  useRouterState: (() => state.location) as never,
}));
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: { ...actual.toastManager, add: state.toast as never, close: vi.fn() },
  };
});
vi.mock(import("../state/hermesCron"), async (original) => ({
  ...(await original()),
  useHermesEnvironmentEnabled: ((id: string) =>
    useAtomValue(hermesCompletionAtom(id)) !== undefined) as never,
  useHermesCron: ((id: string) => ({
    view: { lastCompletion: useAtomValue(hermesCompletionAtom(id)) ?? null },
  })) as never,
}));
vi.mock(import("../state/hermesCronSeen"), async (original) => ({
  ...(await original()),
  reportHermesCompletion: state.reportHermes,
  markHermesTasksSeen: state.markHermesSeen,
}));
vi.mock(import("../state/shell"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentShell: {
      ...actual.environmentShell,
      stateValueAtom: ((id: string) => shellAtom(id)) as never,
    },
  };
});
vi.mock(import("../state/presentation"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentSummaries: {
      ...actual.environmentSummaries,
      // Read lazily: the factory runs before this module's own bindings exist.
      get environmentIdsAtom() {
        return environmentIdsAtom as never;
      },
    },
  };
});
vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((
    select: (settings: {
      notificationMode: string;
      inAppNotificationsEnabled: boolean;
      tabStatusDots: boolean;
    }) => unknown,
  ) =>
    select({
      notificationMode: state.mode,
      inAppNotificationsEnabled: state.inApp,
      tabStatusDots: state.dots,
    })) as never,
  subscribeClientSettings: ((listener: () => void) => {
    state.settingsListeners.add(listener);
    return () => state.settingsListeners.delete(listener);
  }) as never,
  getClientSettings: (() => ({
    notificationMode: state.mode,
    inAppNotificationsEnabled: state.inApp,
    tabStatusDots: state.dots,
  })) as never,
}));
vi.mock(import("../threadNotifications"), async (original) => ({
  ...(await original()),
  playNotificationSound: state.sound,
  unlockNotificationAudio: vi.fn(),
  setNotificationBadge: state.badge,
}));

import { HermesCronNotifications } from "./hermes/HermesCronNotifications";
import { startThreadNotifications } from "./ThreadNotificationCoordinator";

let registry: AtomRegistry.AtomRegistry;
const shellAtom = Atom.family((_id: string) => Atom.make<unknown>(null));
const environmentIdsAtom = Atom.make<ReadonlyArray<string>>([]);
state.shells = { set: (id, value) => registry.set(shellAtom(id), value) };
// Undefined means Hermes is not enabled on that environment.
const hermesCompletionAtom = Atom.family((_id: string) =>
  Atom.make<HermesCronRunCompleted | null | undefined>(undefined),
);
state.hermes = { set: (id, value) => registry.set(hermesCompletionAtom(id), value) };

class TestNotification extends EventTarget {
  static permission = "granted";
  static sent: TestNotification[] = [];
  close = vi.fn();
  get tag() {
    return this.options.tag ?? "";
  }
  constructor(
    readonly title: string,
    readonly options: NotificationOptions,
  ) {
    super();
    TestNotification.sent.push(this);
  }
}

const thread = {
  id: "thread",
  title: "Test thread",
  archivedAt: null as string | null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  session: null as { status: string } | null,
  latestTurn: { turnId: "turn", state: "running", completedAt: null as string | null },
};
let focused = false;
let visibility = "visible";

const SHELL_NOW = DateTime.makeUnsafe("2026-09-13T07:00:00.000Z");

function toV2ThreadShell(input: typeof thread) {
  const latestTurn = input.latestTurn;
  return {
    id: input.id,
    projectId: "project",
    title: input.title,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: input.id,
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: latestTurn.turnId,
    activeRunId: null,
    status:
      latestTurn.state === "completed"
        ? "completed"
        : latestTurn.state === "error" || input.session?.status === "error"
          ? "failed"
          : "running",
    pendingRuntimeRequest: input.hasPendingUserInput
      ? { id: "request-1", kind: "user_input", createdAt: SHELL_NOW }
      : input.hasPendingApprovals
        ? { id: "request-1", kind: "command", createdAt: SHELL_NOW }
        : null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: SHELL_NOW,
    updatedAt: SHELL_NOW,
    latestRunRequestedAt: SHELL_NOW,
    latestRunStartedAt: SHELL_NOW,
    latestRunCompletedAt: latestTurn.completedAt
      ? DateTime.makeUnsafe(latestTurn.completedAt)
      : undefined,
    archivedAt: input.archivedAt ? DateTime.makeUnsafe(input.archivedAt) : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function shell(overrides: Partial<typeof thread> = {}, ...others: Partial<typeof thread>[]) {
  return {
    status: "live",
    snapshot: Option.some({
      threads: [overrides, ...others].map((override) =>
        toV2ThreadShell({ ...thread, ...override }),
      ),
    }),
  };
}
function complete(environment = "one", completedAt = "2026-09-13T08:00:00Z") {
  state.shells.set(
    environment,
    shell({ latestTurn: { turnId: "turn", state: "completed", completedAt } }),
  );
}
function lastBadge() {
  return state.badge.mock.lastCall?.[0];
}

// The mocked modules read `state` and the focus flags, so every test resets them. Tests start
// the service and the first render themselves because some change state first.
function setup() {
  vi.clearAllMocks();
  const stack = new AsyncDisposableStack();
  registry = AtomRegistry.make();
  const testRegistry = registry;
  stack.defer(() => testRegistry.dispose());
  state.mode = "notifications";
  state.inApp = false;
  state.dots = false;
  state.settingsListeners.clear();
  state.location = { pathname: "/", search: {} };
  registry.set(environmentIdsAtom, ["one", "two"]);
  state.shells.set("one", shell());
  state.shells.set("two", shell());
  focused = false;
  visibility = "visible";
  TestNotification.permission = "granted";
  TestNotification.sent = [];
  stack.use(stubGlobal("Notification", TestNotification));
  stack.use(vi.spyOn(window, "focus").mockImplementation(() => undefined));
  stack.use(vi.spyOn(document, "hasFocus").mockImplementation(() => focused));
  stack.use(
    vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => visibility as DocumentVisibilityState),
  );
  const router = {
    state: { matches: [{ params: {} }] },
    navigate: state.navigate,
  } as unknown as AnyRouter;
  const ui = () => (
    <RegistryContext.Provider value={testRegistry}>
      <HermesCronNotifications />
    </RegistryContext.Provider>
  );
  let screen: Screen | undefined;
  return {
    start: () => {
      stack.defer(startThreadNotifications(testRegistry, router));
    },
    setEnvironmentIds: (ids: ReadonlyArray<string>) => testRegistry.set(environmentIdsAtom, ids),
    /** Re-renders the watchers and tells the service the settings may have changed. */
    async flush() {
      for (const listener of state.settingsListeners) listener();
      if (screen) await screen.rerender(ui());
      else screen = stack.use(await render(ui()));
    },
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

function completeHermes(environment = "two", overrides: Partial<HermesCronRunCompleted> = {}) {
  state.hermes.set(environment, {
    jobId: HermesCronJobId.make("job"),
    jobName: "Morning report",
    runId: "run",
    status: "completed",
    finishedAt: null,
    error: null,
    delivery: {
      preview: "The report is ready.",
      contentAvailable: true,
      source: "delivery",
      truncated: false,
      targets: ["local"],
      status: "delivered",
      error: null,
    },
    ...overrides,
  });
}

it("shares Hermes and thread badge counts and opens the exact remote run", async () => {
  await using app = setup();
  state.hermes.set("two", null);
  app.start();
  await app.flush();
  using _timers = fakeTimers();
  complete("one");
  await app.flush();
  await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
  completeHermes();
  await app.flush();
  expect(lastBadge()).toBe(2);
  const notification = TestNotification.sent.at(-1)!;
  expect(notification.options).toMatchObject({ body: "The report is ready.", silent: true });
  notification.dispatchEvent(new Event("click"));
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/hermes",
    search: { environmentId: "two", jobId: "job", runId: "run" },
  });
  app.setEnvironmentIds(["one"]);
  await app.flush();
  expect(lastBadge()).toBe(1);
  window.dispatchEvent(new Event("focus"));
  expect(lastBadge()).toBe(0);
});

it("previews a focused Hermes completion without a badge and does not replay it on preference changes", async () => {
  await using app = setup();
  state.mode = "off";
  state.inApp = true;
  focused = true;
  state.hermes.set("two", null);
  app.start();
  await app.flush();
  completeHermes();
  await app.flush();
  expect(state.toast).toHaveBeenCalledOnce();
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      description: "The report is ready.",
      actionProps: expect.objectContaining({ children: "Open" }),
    }),
  );
  state.toast.mock.calls[0]![0].actionProps.onClick();
  expect(state.navigate).toHaveBeenCalledWith({
    to: "/hermes",
    search: { environmentId: "two", jobId: "job", runId: "run" },
  });
  state.mode = "notifications-and-sound";
  focused = false;
  await app.flush();
  expect(state.toast).toHaveBeenCalledOnce();
  expect(state.reportHermes).toHaveBeenCalledOnce();
  expect(TestNotification.sent).toHaveLength(0);
  expect(state.sound).not.toHaveBeenCalled();
});

it("observes completions while every alert is disabled without replaying them when enabled", async () => {
  await using app = setup();
  state.mode = "off";
  state.hermes.set("two", null);
  app.start();
  await app.flush();
  completeHermes();
  await app.flush();
  state.mode = "notifications";
  await app.flush();
  expect(state.reportHermes).toHaveBeenCalledOnce();
  expect(TestNotification.sent).toHaveLength(0);
  expect(state.toast).not.toHaveBeenCalled();
});

it.each(["off", "sound", "denied", "default", "focused"])(
  "does not show Hermes OS alerts when %s",
  async (condition) => {
    await using app = setup();
    if (condition === "off" || condition === "sound") state.mode = condition;
    if (condition === "focused") focused = true;
    if (condition === "denied" || condition === "default") TestNotification.permission = condition;
    state.hermes.set("two", null);
    app.start();
    await app.flush();
    completeHermes();
    await app.flush();
    expect(TestNotification.sent).toHaveLength(0);
    expect(state.toast).not.toHaveBeenCalled();
    // Background runs still mark the tab; only a focused window skips it.
    expect(lastBadge()).toBe(condition === "focused" ? 0 : 1);
  },
);

it("suppresses the current run's in-app alert but still plays sound and marks it seen", async () => {
  await using app = setup();
  state.mode = "notifications-and-sound";
  state.inApp = true;
  focused = true;
  state.location = {
    pathname: "/hermes",
    search: { environmentId: "two", jobId: "job", runId: "run" },
  };
  state.hermes.set("two", null);
  app.start();
  await app.flush();
  completeHermes();
  await app.flush();
  expect(state.toast).not.toHaveBeenCalled();
  expect(state.sound).toHaveBeenCalledWith("completion", expect.any(Function));
  expect(state.markHermesSeen).toHaveBeenCalledWith("two");
  expect(TestNotification.sent).toHaveLength(0);
});

it("falls back to execution errors for legacy completions and treats hidden windows as unfocused", async () => {
  await using app = setup();
  state.inApp = true;
  state.dots = true;
  focused = true;
  visibility = "hidden";
  state.hermes.set("two", null);
  app.start();
  await app.flush();
  state.hermes.set("two", {
    jobId: HermesCronJobId.make("job"),
    jobName: "Report",
    runId: "run",
    status: "failed",
    finishedAt: null,
    error: "Provider unavailable",
  });
  await app.flush();
  expect(TestNotification.sent.at(-1)?.options.body).toBe("Provider unavailable");
  expect(state.toast).not.toHaveBeenCalled();
  expect(state.badge).toHaveBeenLastCalledWith(1, { kind: "failed", blink: true });
});
