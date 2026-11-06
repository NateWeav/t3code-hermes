/**
 * Which replay scenarios count toward Hermes parity. Every registry scenario with a Claude or Codex
 * variant must appear here. A `twin` scores 0 until its Hermes-worded twin (reusing the reference
 * assertion) exists; `na` is excluded with its reason.
 */

export const FACETS = [
  "turns",
  "tools",
  "approvals",
  "control",
  "planning",
  "subagents",
  "background",
  "context",
  "threads",
] as const;
export type Facet = (typeof FACETS)[number];

export type Applicability =
  | { readonly kind: "applicable" }
  | { readonly kind: "twin"; readonly reason: string; readonly twin?: string }
  | { readonly kind: "na"; readonly reason: string };

export interface ParityScenario {
  readonly name: string;
  readonly facet: Facet;
  readonly hermes: Applicability;
  /** Capability paths (`group.flag`) a passing run demonstrates. */
  readonly exercises?: ReadonlyArray<string>;
  /**
   * Every reference assertion checks its own provider's identity, wire frames or item shapes, so no
   * Hermes run can pass one. Full credit needs those checks moved to the reference's assertProviderDetails.
   */
  readonly providerBound?: true;
}

const applicable = { kind: "applicable" } as const;
const twin = (reason: string, twinName?: string): Applicability => ({
  kind: "twin",
  reason,
  ...(twinName === undefined ? {} : { twin: twinName }),
});
const na = (reason: string): Applicability => ({ kind: "na", reason });

const CLAUDE_AGENT_TOOLS = "The prompt drives Claude's Agent/TaskStop/SendMessage tools.";
const CLAUDE_BASH_BACKGROUND = "The prompt drives Claude's Bash run_in_background.";
const CLAUDE_COMPACT =
  "The prompt sends Claude's /compact; Hermes compacts with /compress. Claude's assertOutput still pins its recorded token counts, usage and wake or peer turn, which a twin needs moved to assertProviderDetails.";

export const PARITY_SCENARIOS: ReadonlyArray<ParityScenario> = [
  // Turn loop
  {
    name: "simple",
    facet: "turns",
    hermes: applicable,
    exercises: ["turns.emitsTurnCompleted", "streaming.streamsAssistantText"],
  },
  { name: "multi_turn", facet: "turns", hermes: applicable },
  {
    name: "multi_turn_restart",
    facet: "turns",
    hermes: na(
      "The restart is the Claude recorder's per-turn SDK query mode; for any other provider the input is multi_turn.",
    ),
  },
  { name: "claude_idle_resume", facet: "turns", hermes: applicable },
  {
    name: "claude_result_is_error",
    facet: "turns",
    hermes: na("Replays a Claude SDK auth-error result frame."),
  },
  {
    name: "codex_model_reroute",
    facet: "turns",
    hermes: na("Replays Codex's server-side model reroute notice."),
  },

  // Tools and their output
  { name: "tool_call_read_only", facet: "tools", hermes: applicable },
  {
    name: "command_output_streaming",
    facet: "tools",
    hermes: applicable,
    exercises: ["streaming.streamsToolOutput", "tools.emitsToolOutput"],
  },
  { name: "web_search", facet: "tools", hermes: applicable, providerBound: true },
  { name: "claude_local_bash_task", facet: "tools", hermes: applicable },
  {
    name: "claude_mcp_tool_presentation",
    facet: "tools",
    hermes: na("Needs a Firecrawl MCP server configured for the agent."),
  },

  // Approvals and permission modes
  {
    name: "tool_call_read_only_on_request",
    facet: "approvals",
    hermes: applicable,
    exercises: ["approvals.supportsCommandApproval", "approvals.supportsFileChangeApproval"],
  },
  { name: "tool_call_workspace_never", facet: "approvals", hermes: applicable },
  { name: "tool_call_restricted_granular", facet: "approvals", hermes: applicable },
  {
    name: "tool_call_denied_write",
    facet: "approvals",
    hermes: twin("The prompt names Claude's Write tool."),
  },

  // Interrupt, steer, queue
  {
    name: "turn_interrupt",
    facet: "control",
    hermes: applicable,
    exercises: ["turns.supportsInterrupt"],
  },
  // Not provider-bound: this and the restart below share an assertion on the stopped command row,
  // which every provider's fixture passes.
  {
    name: "turn_interrupt_mid_tool",
    facet: "control",
    hermes: applicable,
    exercises: ["turns.supportsInterrupt"],
  },
  { name: "turn_interrupt_restart", facet: "control", hermes: applicable },
  // Hermes steers by restart, like Grok; Claude and Codex steer the running turn. Hermes's `/steer`
  // lands only after a tool batch and reports no delivery, so T3 cannot steer through it.
  {
    name: "message_steering",
    facet: "control",
    hermes: applicable,
    providerBound: true,
    exercises: ["turns.supportsSteeringByInterruptRestart"],
  },
  {
    name: "queued_turn",
    facet: "control",
    hermes: applicable,
    exercises: ["turns.supportsQueuedMessages"],
  },
  { name: "queued_cancelled_while_active", facet: "control", hermes: applicable },

  // Plans, todos, questions
  {
    name: "todo_list",
    facet: "planning",
    hermes: twin(
      "The prompt names Codex's update_plan tool; Hermes tracks todos with its todo tool.",
      "hermes_todo_list",
    ),
    exercises: ["planning.emitsTodoList"],
  },
  {
    name: "plan_questions",
    facet: "planning",
    hermes: twin(
      "The prompt names Codex's request_user_input tool; Hermes asks with clarify, which stock Hermes leaves out of ACP sessions.",
    ),
    exercises: ["planning.supportsStructuredQuestions"],
  },
  {
    name: "proposed_plan",
    facet: "planning",
    hermes: applicable,
    exercises: ["planning.emitsProposedPlan"],
  },

  // Subagents
  {
    name: "subagent",
    facet: "subagents",
    hermes: applicable,
    providerBound: true,
    exercises: ["subagents.supportsSubagents", "subagents.emitsSubagentLifecycle"],
  },
  { name: "subagent_continue", facet: "subagents", hermes: applicable },
  { name: "subagent_v2", facet: "subagents", hermes: applicable, providerBound: true },
  {
    name: "subagent_v2_approval",
    facet: "subagents",
    hermes: applicable,
    exercises: ["approvals.approvalsCanOriginateFromSubagents"],
  },
  { name: "subagent_v2_nested", facet: "subagents", hermes: applicable, providerBound: true },
  { name: "subagent_v2_nested_approval", facet: "subagents", hermes: applicable },
  {
    name: "claude_nested_subagent_model",
    facet: "subagents",
    hermes: twin(
      "The prompt drives Claude's Agent tool with a per-subagent model. Hermes's delegate_task cannot pick one: `model` is a reserved task parameter, so children run on delegation.model or the parent's model.",
    ),
  },

  // Background work that outlives the turn
  {
    name: "claude_background_task_after_root",
    facet: "background",
    hermes: twin(CLAUDE_BASH_BACKGROUND),
  },
  {
    name: "claude_background_task_wake",
    facet: "background",
    hermes: twin(CLAUDE_BASH_BACKGROUND),
  },
  {
    name: "claude_background_task_interrupt",
    facet: "background",
    hermes: twin(CLAUDE_BASH_BACKGROUND),
  },
  {
    name: "claude_background_subagent_after_root",
    facet: "background",
    hermes: twin(CLAUDE_AGENT_TOOLS),
  },
  {
    name: "claude_background_subagent_lifecycle",
    facet: "background",
    hermes: twin(CLAUDE_AGENT_TOOLS),
  },
  {
    name: "claude_background_wake_before_queued_prompt",
    facet: "background",
    hermes: twin(CLAUDE_AGENT_TOOLS),
  },
  {
    name: "claude_background_wake_before_queued_prompt_no_echo",
    facet: "background",
    hermes: na("Covers Claude's SDK not echoing a queued prompt."),
  },
  {
    name: "claude_nested_background_subagent_wake",
    facet: "background",
    hermes: twin(CLAUDE_AGENT_TOOLS),
  },
  {
    name: "claude_background_monitor_wake",
    facet: "background",
    hermes: na("Claude's Monitor tool has no Hermes counterpart."),
  },

  // Context: compaction and resume
  { name: "claude_compact_after_resume_wake", facet: "context", hermes: twin(CLAUDE_COMPACT) },
  { name: "claude_compact_after_peer_turn", facet: "context", hermes: twin(CLAUDE_COMPACT) },
  {
    name: "claude_compact_after_peer_turn_no_echo",
    facet: "context",
    hermes: na("Covers Claude's SDK not echoing /compact."),
  },

  // Thread operations
  {
    name: "thread_rollback",
    facet: "threads",
    hermes: applicable,
    exercises: ["threads.canRollbackThread", "checkpointing.providerCanRollbackConversation"],
  },
  { name: "thread_rollback_after_restart", facet: "threads", hermes: applicable },
  { name: "thread_rollback_to_stopped_turn", facet: "threads", hermes: applicable },
];
