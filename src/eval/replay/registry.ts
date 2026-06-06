/**
 * TapeRegistry — a ToolRegistry that returns recorded tool results instead
 * of executing real tools.
 *
 * Behaviour: every recorded tool result from the tape is loaded into a
 * single FIFO queue at construction. Each `execute()` call pops the next
 * result matching the call's name. Because `executeCalls` returns results
 * in CALL order (Promise.all preserves array order), the recorded JSONL
 * pairs calls with results in matching order — so a name-matched FIFO is
 * correct as long as the agent's call sequence matches the recording.
 *
 * If a tool call has no matching recorded result (mismatched name, count
 * exceeded), `execute()` returns an error result — same shape as the real
 * registry would for an unknown tool. This is also the signal that the
 * agent's tool selection diverged from the recording.
 *
 * Synthesised tools are registered for every distinct tool name in the tape
 * so the agent's `tools.all().map(toolToDefinition)` step doesn't choke and
 * `tools.get(name)?.readonly` returns a useful value. The synthesised tools
 * intentionally have NO `requiresConfirmation` predicate — confirmation
 * gates would otherwise diverge replay from the recorded trajectory.
 *
 * `readonly` defaults to `true` for unknown tool names. The replay's
 * sequential-vs-parallel batching decision in the executor depends on this;
 * defaulting read-only preserves parallel batches, the more common case.
 */
import { ToolRegistry } from "../../tools/registry.js";
import type { Tool } from "../../tools/base.js";
import type { ToolResult } from "../../providers/types.js";
import type { RecordedToolResult, Tape } from "./tape.js";

const READ_ONLY_TOOL_NAMES = new Set([
  "read",
  "glob",
  "grep",
  "ls",
  "think",
  "web_fetch",
  "todo_read",
]);

export class TapeRegistry extends ToolRegistry {
  private queue: RecordedToolResult[];
  /** Tracks every (name, args) execute() call made through the registry. */
  readonly executionLog: { name: string; args: Record<string, unknown> }[] = [];

  constructor(tape: Tape) {
    super();
    this.queue = [];
    const toolNames = new Set<string>();

    for (const turn of tape.turns) {
      for (const iter of turn.iterations) {
        for (const r of iter.toolResults) this.queue.push(r);
        for (const c of iter.toolCalls) toolNames.add(c.name);
      }
    }

    for (const name of toolNames) {
      const tool: Tool = {
        name,
        description: `[replay stub] ${name}`,
        parameters: { type: "object", properties: {} },
        readonly: READ_ONLY_TOOL_NAMES.has(name),
        execute: async () => ({ success: true, output: "" }),
      };
      this.register(tool);
    }
  }

  override async execute(name: string, params: Record<string, unknown>): Promise<ToolResult> {
    this.executionLog.push({ name, args: params });

    // activate_skill is handled inside the executor before reaching the
    // registry — it should never appear here. If it does, fail loudly.
    if (name === "activate_skill") {
      return {
        success: false,
        output: "",
        error: "TapeRegistry: activate_skill reached execute() — bug in caller.",
      };
    }

    const idx = this.queue.findIndex((r) => r.name === name);
    if (idx === -1) {
      return {
        success: false,
        output: "",
        error:
          `TapeRegistry: no recorded result for '${name}'. The replayed ` +
          `trajectory has the agent calling '${name}' but the tape has no ` +
          `unconsumed result for it. This usually means the agent's tool ` +
          `selection diverged from the recording.`,
      };
    }

    const [recorded] = this.queue.splice(idx, 1);
    return { success: true, output: recorded.result };
  }

  /** Remaining recorded results not yet served. Useful for end-of-replay
   *  assertions. */
  unconsumed(): number {
    return this.queue.length;
  }
}
