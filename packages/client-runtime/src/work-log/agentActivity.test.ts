import { describe, expect, it } from "vite-plus/test";

import {
  agentActivityDisplayName,
  annotateAgentActivity,
  classifyAgentActivity,
  extractProviderToolTitle,
} from "./agentActivity.ts";
import { resolveWorkEntryToolPresentation, summarizeToolGroup } from "./presentation.ts";

describe("classifyAgentActivity", () => {
  it.each([
    // Titles as Hermes' ACP adapter builds them, taken from recorded threads.
    [
      "skill view (development-planning-and-quality)",
      "Loaded skill development-planning-and-quality",
    ],
    [
      "skill view (hermes-agent/references/cli-reference.md)",
      "Read skill file hermes-agent/references/cli-reference.md",
    ],
    // Older Hermes versions used the raw tool name.
    ["skill_view: minecraft-avalon-operations", "Loaded skill minecraft-avalon-operations"],
    ["skills list", "Listed skills"],
    ["skills list (devops)", "Listed skills in devops"],
    ["skill create: t3-review", "Created skill t3-review"],
    ["skill patch: t3-hermes-fork-maintenance", "Updated skill t3-hermes-fork-maintenance"],
    [
      "skill write_file: t3-review/references/api.md",
      "Added a file to skill t3-review/references/api.md",
    ],
    ["skill delete: old-skill", "Deleted skill old-skill"],
    ["memory add: user", "Saved to the user profile"],
    ["memory replace: memory", "Updated memory"],
    ["memory remove: memory", "Removed from memory"],
    [
      "hindsight_recall: T3 usage tab Claude CLIProxyAPI usage",
      "Recalled memories: T3 usage tab Claude CLIProxyAPI usage",
    ],
    ["hindsight_retain", "Saved a long-term memory"],
    ["hindsight_reflect: Is Hindsight healthy?", "Reflected on memories: Is Hindsight healthy?"],
    [
      'session search: "upgrade" OR "upgrading"',
      'Searched past sessions: "upgrade" OR "upgrading"',
    ],
    ["recent sessions", "Browsed recent sessions"],
  ])("names %s", (title, displayName) => {
    const activity = classifyAgentActivity(title);
    expect(activity).not.toBeNull();
    expect(agentActivityDisplayName(activity!, "completed")).toBe(displayName);
  });

  it.each(["Read file", "terminal: ls", "todo (3 items)", "skill view", "memory add: notes", ""])(
    "leaves %j alone",
    (title) => {
      expect(classifyAgentActivity(title)).toBeNull();
    },
  );

  it("describes each lifecycle state", () => {
    const activity = classifyAgentActivity("skill view (t3-review)")!;
    expect(agentActivityDisplayName(activity, "inProgress")).toBe("Loading skill t3-review");
    expect(agentActivityDisplayName(activity, "failed")).toBe("Failed to load skill t3-review");
    expect(agentActivityDisplayName(activity, undefined)).toBe("Loading skill t3-review");
  });
});

describe("extractProviderToolTitle", () => {
  it("reads the provider title the canonical title replaced", () => {
    expect(
      extractProviderToolTitle({
        title: "Read file",
        data: { title: "skill view (t3-review)", kind: "read" },
      }),
    ).toBe("skill view (t3-review)");
    expect(extractProviderToolTitle({ title: "Read file" })).toBeUndefined();
    expect(extractProviderToolTitle(null)).toBeUndefined();
  });
});

describe("annotateAgentActivity", () => {
  const skillRead = {
    id: "skill-read",
    createdAt: "2026-10-01T00:00:00.000Z",
    label: "Read file",
    tone: "tool" as const,
    toolTitle: "Read file",
    providerToolTitle: "skill view (t3-review)",
    itemType: "dynamic_tool" as const,
  };
  const memoryWrite = {
    id: "memory-write",
    createdAt: "2026-10-01T00:00:01.000Z",
    label: "memory add: user",
    tone: "tool" as const,
    toolTitle: "memory add: user",
    itemType: "dynamic_tool" as const,
  };

  it("returns the same entries when both kinds are off", () => {
    const entries = [skillRead, memoryWrite];
    expect(annotateAgentActivity(entries, { skills: false, memory: false })).toBe(entries);
    expect(annotateAgentActivity(entries, undefined)).toBe(entries);
  });

  it("annotates only the kinds the user turned on", () => {
    const [skill, memory] = annotateAgentActivity([skillRead, memoryWrite], {
      skills: true,
      memory: false,
    });
    expect(skill).not.toBe(skillRead);
    expect(skill?.agentActivity).toEqual({ kind: "skill", action: "view", name: "t3-review" });
    expect(memory).toBe(memoryWrite);
  });

  it("replaces the flattened label and groups skill and memory work by name", () => {
    const annotated = annotateAgentActivity([skillRead, memoryWrite, memoryWrite], {
      skills: true,
      memory: true,
    });
    expect(
      resolveWorkEntryToolPresentation({ ...annotated[0]!, toolLifecycleStatus: "completed" }),
    ).toEqual({ displayName: "Loaded skill t3-review", icon: "skill", action: "skill" });
    expect(summarizeToolGroup(annotated).summary).toBe("Used 1 skill and used memory 2 times");
    // Off, the same rows keep the stock grouping.
    expect(summarizeToolGroup([skillRead]).summary).toBe("Read 1 file");
  });
});
