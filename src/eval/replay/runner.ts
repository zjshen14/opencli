/**
 * Replay runner — drives an Agent against a Tape and captures everything
 * needed for assertions.
 *
 * Returns the captured ObservabilityEvent stream (the primary contract
 * surface), the AgentEvent stream the agent yielded (for tool-call /
 * notice / error inspection), the message-snapshots TapeClient recorded on
 * each stream() call (the inspection hook for prune-anchor and context
 * shape), and the TapeRegistry / TapeClient state (for exhaustion checks).
 *
 * The compaction client is a stub that returns a fixed summary — replay
 * is fully offline. The summary text is short and clearly synthetic so
 * any assertion that accidentally relies on summary content fails loudly.
 */
import { Agent } from "../../core/agent.js";
import type { AgentEvent } from "../../core/agent.js";
import type { ObservabilityEvent } from "../../core/observability.js";
import type { ConfirmFn } from "../../core/executor.js";
import type { LLMClient } from "../../providers/client.js";
import type { StreamEvent } from "../../providers/types.js";
import { SkillRegistry } from "../../skills/registry.js";
import { TapeClient, type SentMessages } from "./client.js";
import { TapeRegistry } from "./registry.js";
import type { Tape } from "./tape.js";

const STUB_COMPACTION_SUMMARY = `## Task
[replay-stub summary]

## Progress
[replay-stub] tool calls compacted

## Decisions
[replay-stub]

## Errors
[replay-stub]

## State
[replay-stub] continuing replay`;

/** A compaction LLMClient that returns a fixed summary string — replay
 *  must remain fully offline even when auto-compact fires. */
function stubCompactionClient(): LLMClient {
  return {
    async *stream(): AsyncGenerator<StreamEvent> {
      yield { type: "text", text: STUB_COMPACTION_SUMMARY };
      yield { type: "done" };
    },
  };
}

export interface ReplayResult {
  observability: ObservabilityEvent[];
  agentEvents: AgentEvent[];
  sentMessages: SentMessages[];
  /** Tool calls recorded by the TapeRegistry, in order. */
  executionLog: { name: string; args: Record<string, unknown> }[];
  /** Recorded results still queued in the registry after replay — should
   *  normally be 0; non-zero means the agent didn't make all expected
   *  calls (early termination, guard fired, etc.). */
  unconsumedResults: number;
  /** True when every recorded LLM iteration was consumed. */
  tapeExhausted: boolean;
}

export interface RunTapeOptions {
  /** Model name passed to Agent — drives context-window selection and
   *  the auto-compact trigger ratio. Required because compaction math
   *  depends on it. */
  model: string;
  /** Max turns per agent.run(). Default 50 (Agent default). */
  maxTurns?: number;
  /** Disable auto-compact for tapes that exercise prune-only behaviour. */
  autoCompact?: boolean;
  /** Override the system instruction (default empty — replay does not
   *  exercise the system prompt). */
  systemInstruction?: string;
  /** Wire a confirmFn for HITL contract evals. When omitted, no confirmFn is
   *  set and the executor auto-denies any tool that requires confirmation
   *  (emitting tool_denied with reason "non_interactive"). */
  confirmFn?: ConfirmFn;
  /** Force confirmation for matching tool calls. Useful when TapeRegistry
   *  tools intentionally carry no requiresConfirmation predicate but a test
   *  needs to exercise the HITL gate. */
  forcesConfirmation?: (toolName: string, args: Record<string, unknown>) => boolean;
}

export async function runTape(tape: Tape, opts: RunTapeOptions): Promise<ReplayResult> {
  const client = new TapeClient(tape);
  const tools = new TapeRegistry(tape);
  const skills = new SkillRegistry();

  const observability: ObservabilityEvent[] = [];
  const agentEvents: AgentEvent[] = [];

  const agent = new Agent(
    client,
    tools,
    skills,
    opts.systemInstruction ?? "",
    undefined, // maxHistoryMessages — use ContextManager default
    opts.maxTurns,
    {
      model: opts.model,
      onObservability: (e) => observability.push(e),
      compactionClient: stubCompactionClient(),
      autoCompact: opts.autoCompact !== false,
    },
  );

  if (opts.confirmFn) agent.setConfirmFn(opts.confirmFn);
  if (opts.forcesConfirmation) agent.setForcesConfirmationFn(opts.forcesConfirmation);

  for (const turn of tape.turns) {
    for await (const event of agent.run(turn.userInput, turn.mode)) {
      agentEvents.push(event);
    }
  }

  return {
    observability,
    agentEvents,
    sentMessages: client.sentMessages,
    executionLog: tools.executionLog,
    unconsumedResults: tools.unconsumed(),
    tapeExhausted: client.exhausted(),
  };
}
