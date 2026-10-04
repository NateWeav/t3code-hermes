import { describe, expect, it } from "@effect/vitest";
import { ThreadId, type OrchestrationV2TurnItem } from "@t3tools/contracts";

import type { HermesMessageRow } from "./hermesRunState.ts";
import { hermesRunItemsFor, isSilentReport, type HermesToolCall } from "./hermesRunTranscript.ts";

const prefix = "hermes-run:default:s1";
const ids = { threadId: ThreadId.make(prefix), prefix };

const row = (fields: Partial<HermesMessageRow> & Pick<HermesMessageRow, "id" | "role">) => ({
  content: "",
  toolCallId: null,
  toolCalls: null,
  toolName: null,
  reasoning: null,
  timestamp: 1_790_000_000 + fields.id,
  ...fields,
});

const toolCall = (id: string, name: string, args: Record<string, unknown>) =>
  JSON.stringify([{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }]);

function items(batch: ReturnType<typeof hermesRunItemsFor>): OrchestrationV2TurnItem[] {
  return batch.entries.map((entry) => entry.item);
}

describe("hermesRunItemsFor", () => {
  it("mirrors a run's prompt, tool calls, and report as run-less turn items", () => {
    const pending = new Map<string, HermesToolCall>();
    const batch = hermesRunItemsFor(
      ids,
      [
        row({ id: 1, role: "user", content: "Resolve the upstream conflict" }),
        row({
          id: 2,
          role: "assistant",
          toolCalls: toolCall("call-1", "terminal", { command: "gh pr create --fill" }),
        }),
      ],
      pending,
    );
    expect(items(batch)).toMatchObject([
      { type: "user_message", text: "Resolve the upstream conflict", runId: null },
      {
        id: `${prefix}:tool:call-1`,
        type: "command_execution",
        input: "gh pr create --fill",
        status: "running",
        completedAt: null,
      },
    ]);
    expect(batch.entries[0]?.message).toMatchObject({ role: "user", runId: null });

    // The result lands in a later poll; the pending call carries across.
    const next = hermesRunItemsFor(
      ids,
      [
        row({
          id: 3,
          role: "tool",
          toolCallId: "call-1",
          toolName: "terminal",
          content: JSON.stringify({
            output: "https://github.com/NateWeav/t3code-hermes/pull/72\n",
            exit_code: 0,
          }),
        }),
        row({ id: 4, role: "assistant", content: "Opened the resolution PR and CI is green." }),
      ],
      pending,
    );
    const [finished, report] = items(next);
    expect(finished).toMatchObject({
      id: `${prefix}:tool:call-1`,
      type: "command_execution",
      status: "completed",
      output: "https://github.com/NateWeav/t3code-hermes/pull/72\n",
      exitCode: 0,
    });
    // A finished call keeps the time it started.
    expect(finished?.startedAt).toEqual(items(batch)[1]?.startedAt);
    expect(report).toMatchObject({ type: "assistant_message", messageId: `${prefix}:m4` });
    expect(next.pullRequestUrls).toEqual(["https://github.com/NateWeav/t3code-hermes/pull/72"]);
    expect(next.lastAssistantText).toBe("Opened the resolution PR and CI is green.");
    expect(pending.size).toBe(0);
  });

  it("marks a failed command as failed", () => {
    const pending = new Map<string, HermesToolCall>([
      ["call-2", { name: "terminal", args: { command: "vp test" } }],
    ]);
    const batch = hermesRunItemsFor(
      ids,
      [
        row({
          id: 5,
          role: "tool",
          toolCallId: "call-2",
          content: JSON.stringify({ output: "1 failed", exit_code: 1 }),
        }),
      ],
      pending,
    );
    expect(items(batch)[0]).toMatchObject({ status: "failed", outputIndicatesFailure: true });
  });

  it("keeps a terminal error's text when there is no output", () => {
    const pending = new Map<string, HermesToolCall>([
      ["call-e", { name: "terminal", args: { command: "gh pr create" } }],
    ]);
    const batch = hermesRunItemsFor(
      ids,
      [
        row({
          id: 8,
          role: "tool",
          toolCallId: "call-e",
          content: JSON.stringify({ error: "gh: command not found" }),
        }),
      ],
      pending,
    );
    expect(JSON.stringify(items(batch)[0])).toContain("gh: command not found");
  });

  it("maps file edits, searches, and other tools to their item kinds", () => {
    const batch = hermesRunItemsFor(
      ids,
      [
        row({
          id: 9,
          role: "assistant",
          reasoning: "Check the composer first.",
          toolCalls: JSON.stringify([
            { id: "a", function: { name: "patch", arguments: '{"path":"src/a.ts"}' } },
            { id: "b", function: { name: "search_files", arguments: '{"pattern":"TODO"}' } },
            { id: "c", function: { name: "skill_manage", arguments: "{}" } },
            { id: "d", function: { name: "delegate_task", arguments: '{"goal":"x"}' } },
          ]),
        }),
      ],
      new Map(),
    );
    expect(items(batch).map((item) => item.type)).toEqual([
      "reasoning",
      "file_change",
      "file_search",
      "file_change",
      "dynamic_tool",
    ]);
  });

  it("ignores pull request URLs a run only read about", () => {
    const pending = new Map<string, HermesToolCall>([
      ["call-3", { name: "web_extract", args: { urls: ["https://github.com/o/r/pull/1"] } }],
    ]);
    const batch = hermesRunItemsFor(
      ids,
      [
        row({
          id: 6,
          role: "tool",
          toolCallId: "call-3",
          content: "https://github.com/o/r/pull/1",
        }),
      ],
      pending,
    );
    expect(batch.pullRequestUrls).toEqual([]);
  });

  it("links only the pull requests a run created, not ones `gh pr list` or `view` printed", () => {
    const commands = {
      "call-list":
        "gh pr list --repo NateWeav/t3code-hermes --state open --json number,title,headRefName,url",
      "call-view": "gh pr view 95 --repo NateWeav/t3code-hermes",
      "call-create": "gh pr create --fill",
    };
    const outputs = {
      "call-list": '[{"number":94,"url":"https://github.com/NateWeav/t3code-hermes/pull/94"}]',
      "call-view": "url:\thttps://github.com/NateWeav/t3code-hermes/pull/95\n",
      "call-create": "https://github.com/NateWeav/t3code-hermes/pull/98\n",
    };
    const pending = new Map<string, HermesToolCall>(
      Object.entries(commands).map(([id, command]) => [
        id,
        { name: "terminal", args: { command } },
      ]),
    );
    const batch = hermesRunItemsFor(
      ids,
      Object.entries(outputs).map(([toolCallId, output], index) =>
        row({
          id: 20 + index,
          role: "tool",
          toolCallId,
          content: JSON.stringify({ output, exit_code: 0 }),
        }),
      ),
      pending,
    );
    expect(batch.pullRequestUrls).toEqual(["https://github.com/NateWeav/t3code-hermes/pull/98"]);
  });

  it("derives the same items on replay, so re-reading rows writes nothing new", () => {
    const rows = [row({ id: 7, role: "assistant", content: "hello" })];
    const first = hermesRunItemsFor(ids, rows, new Map());
    const second = hermesRunItemsFor(ids, rows, new Map());
    expect(second.entries).toEqual(first.entries);
  });
});

describe("isSilentReport", () => {
  it("recognises Hermes's nothing-to-report answer", () => {
    expect(isSilentReport("[SILENT]")).toBe(true);
    expect(isSilentReport("  [SILENT] nothing to do")).toBe(true);
    expect(isSilentReport("Merged the PR")).toBe(false);
    expect(isSilentReport(null)).toBe(false);
  });
});
