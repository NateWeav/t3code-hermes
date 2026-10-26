import { WORKING_EXIT_GRACE_MS } from "@t3tools/client-runtime/state/thread-inbox";
import type { AnyRouter } from "@tanstack/react-router";
import type { ClientSettings } from "@t3tools/contracts/settings";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { fakeTimers, stubGlobal } from "../../test/render";

const state = vi.hoisted(() => ({
  mode: "off" as ClientSettings["notificationMode"],
  inApp: true,
  active: { environmentId: "env-1", threadId: "other-thread" },
  focused: true,
  visible: "visible",
  live: true,
  completedAt: null as string | null,
  archivedAt: null as string | null,
  input: false,
  approval: false,
  sessionError: false,
  turnError: false,
  limited: false,
  subagent: false,
  background: [] as Array<{ taskId: string; kind: "command" | "monitor" }>,
  watchingPullRequest: false,
  hermesRun: null as { profile: string; sourceKey: string; sessionId: string } | null,
  latestRunId: "run-1" as string | null,
  delegatedChild: null as "running" | "approval" | null,
  add: vi.fn(
    (_toast: { title: string; description: string; actionProps: { onClick: () => void } }) =>
      "toast-1",
  ),
  close: vi.fn(),
  navigate: vi.fn(),
  sound: vi.fn(),
  notification: vi.fn(function (_title: string, options: NotificationOptions) {
    return Object.assign(new EventTarget(), { tag: options.tag, close: vi.fn() });
  }),
}));

const SHELL_NOW = DateTime.makeUnsafe("2026-09-13T09:00:00.000Z");

const watchedPullRequest = {
  host: "github.com",
  repository: "pingdotgg/t3code",
  number: 1,
  url: "https://github.com/pingdotgg/t3code/pull/1",
  source: "agent",
  linkedAt: "2026-09-13T09:00:00.000Z",
  snapshot: null,
  stack: null,
  watch: {
    startedAt: "2026-09-13T09:00:00.000Z",
    headSha: null,
    failedChecks: [],
    passed: false,
    remarksThrough: "2026-09-13T09:00:00.000Z",
    remarkIds: [],
    conflicting: false,
    wakes: 0,
  },
};

function mockThreadShell() {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Fix the login form",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: "thread-1",
      parentThreadId: state.subagent ? "parent" : null,
      relationshipToParent: state.subagent ? "subagent" : null,
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: state.latestRunId,
    activeRunId: null,
    hermesRun: state.hermesRun,
    status: state.completedAt
      ? "completed"
      : state.sessionError || state.turnError || state.limited
        ? "failed"
        : "running",
    lastErrorClass: state.limited ? "usage_limit" : null,
    pendingRuntimeRequest: state.input
      ? { id: "request-1", kind: "user_input", createdAt: SHELL_NOW }
      : state.approval
        ? { id: "request-1", kind: "command", createdAt: SHELL_NOW }
        : null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: state.background,
    pullRequests: state.watchingPullRequest ? [watchedPullRequest] : [],
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: SHELL_NOW,
    updatedAt: SHELL_NOW,
    latestRunRequestedAt: SHELL_NOW,
    latestRunStartedAt: SHELL_NOW,
    latestRunCompletedAt: state.completedAt ? DateTime.makeUnsafe(state.completedAt) : undefined,
    archivedAt: state.archivedAt ? DateTime.makeUnsafe(state.archivedAt) : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

let stableParent: ReturnType<typeof mockThreadShell> | null = null;
function mockThreads() {
  if (state.delegatedChild === null) return [mockThreadShell()];
  stableParent ??= mockThreadShell();
  const child = {
    ...mockThreadShell(),
    id: "child-1",
    title: "Review the login form",
    creationSource: "mcp",
    lineage: {
      rootThreadId: "thread-1",
      parentThreadId: "thread-1",
      relationshipToParent: "subagent",
    },
    pendingRuntimeRequest:
      state.delegatedChild === "approval"
        ? { id: "request-2", kind: "command", createdAt: SHELL_NOW }
        : null,
  };
  return [stableParent, child];
}

vi.mock(import("../state/shell"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentShell: {
      ...actual.environmentShell,
      stateValueAtom: (() => shellAtom) as never,
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
  subscribeClientSettings: (() => () => undefined) as never,
  getClientSettings: (() => ({
    notificationMode: state.mode,
    inAppNotificationsEnabled: state.inApp,
    tabStatusDots: false,
  })) as never,
}));
vi.mock(import("../threadNotifications"), async (original) => ({
  ...(await original()),
  playNotificationSound: state.sound,
  setNotificationBadge: vi.fn(),
}));
vi.mock(import("./ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: { ...actual.toastManager, add: state.add as never, close: state.close },
  };
});

import { startThreadNotifications } from "./ThreadNotificationCoordinator";

const shellAtom = Atom.make<unknown>(null);
const environmentIdsAtom = Atom.make<ReadonlyArray<string>>(["env-1"]);

// The mocked modules read `state`, so every test starts by resetting all of it. Starting the
// service is left to the test because some tests change state first.
function setup() {
  vi.clearAllMocks();
  Object.assign(state, {
    mode: "off",
    inApp: true,
    active: { environmentId: "env-1", threadId: "other-thread" },
    focused: true,
    visible: "visible",
    live: true,
    completedAt: null,
    archivedAt: null,
    input: false,
    approval: false,
    sessionError: false,
    turnError: false,
    limited: false,
    subagent: false,
    background: [],
    watchingPullRequest: false,
    hermesRun: null,
    latestRunId: "run-1",
    delegatedChild: null,
  });
  stableParent = null;
  const stack = new AsyncDisposableStack();
  stack.use(
    vi
      .spyOn(document, "visibilityState", "get")
      .mockImplementation(() => state.visible as DocumentVisibilityState),
  );
  stack.use(vi.spyOn(document, "hasFocus").mockImplementation(() => state.focused));
  stack.use(
    stubGlobal("Notification", Object.assign(state.notification, { permission: "granted" })),
  );
  const registry = AtomRegistry.make();
  stack.defer(() => registry.dispose());
  const router = {
    get state() {
      return { matches: [{ params: state.active }] };
    },
    navigate: state.navigate,
  } as unknown as AnyRouter;
  let started = false;
  // Publishes a fresh shell snapshot, as the live subscription would.
  const publish = () =>
    registry.set(shellAtom, {
      status: state.live ? "live" : "disconnected",
      snapshot: Option.some({ threads: mockThreads() }),
    });
  const renderCoordinator = async () => {
    publish();
    if (!started) {
      started = true;
      stack.defer(startThreadNotifications(registry, router));
    }
  };
  return {
    render: renderCoordinator,
    complete: async () => {
      state.completedAt = "2026-09-13T10:00:00.000Z";
      publish();
    },
    [Symbol.asyncDispose]: () => stack.disposeAsync(),
  };
}

describe("thread notifications", () => {
  it.each([
    ["a default-profile cron run", "default", "cron:digest", null, 0],
    ["a reply after a cron run", "default", "cron:digest", "run-reply", 1],
  ] as const)(
    "leaves %s's alert to Hermes Tasks only when Tasks announces it",
    async (_case, profile, sourceKey, latestRunId, alerts) => {
      await using app = setup();
      state.hermesRun = { profile, sourceKey, sessionId: "cron_1" };
      state.latestRunId = latestRunId;
      await app.render();
      using _timers = fakeTimers();
      await app.complete();
      await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
      expect(state.add).toHaveBeenCalledTimes(alerts);
    },
  );

  it("announces a finished turn while the agent watches a pull request", async () => {
    await using app = setup();
    state.watchingPullRequest = true;
    await app.render();
    using _timers = fakeTimers();
    await app.complete();
    await vi.advanceTimersByTimeAsync(WORKING_EXIT_GRACE_MS);
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Thread completed" }),
    );
  });
});
