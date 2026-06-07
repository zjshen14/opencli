/**
 * Tape model — turns a session JSONL into a structure the replay harness
 * can drive an Agent against.
 *
 * Shape: a JSONL session is a flat event log (user, tool_call, tool_result,
 * assistant) emitted in stream order. The Agent loop is multi-iteration: one
 * `agent.run()` call may call `LLMClient.stream()` many times, each iteration
 * potentially producing text + a batch of tool_calls. The JSONL flattens this
 * — text from every iteration is concatenated into one trailing `assistant`
 * entry per run, and tool_calls/results appear in stream order without
 * iteration markers.
 *
 * To replay, we group events into AgentTurn[] (one per `agent.run()` —
 * delimited by `user` entries) and within each AgentTurn into
 * LLMIteration[] (one per `stream()` call — reconstructed from the
 * tool_call/tool_result pattern).
 *
 * Iteration-boundary heuristic: a new iteration starts when a `tool_call`
 * appears AFTER one or more `tool_result`s — the prior iteration's results
 * have come back and the LLM is being asked again. The final iteration is
 * always text-only (the trailing `assistant` entry) — it carries the
 * accumulated text from every iteration concatenated together; replay
 * attributes all of it to this final iteration, which is faithful for
 * agent-loop behavior even though per-iteration text interleaving is lost.
 */
import type { SessionEntry } from "../../state/session.js";

export interface RecordedToolCall {
  name: string;
  args: Record<string, unknown>;
  thoughtSignature?: string;
}

export interface RecordedToolResult {
  name: string;
  result: string;
}

export interface LLMIteration {
  /** Text the LLM streamed during this iteration. Empty for non-final
   *  iterations (text is concatenated into the final iteration — see file
   *  docstring). */
  text: string;
  /** Tool calls the LLM emitted during this iteration. */
  toolCalls: RecordedToolCall[];
  /** Tool results paired with the calls. Same length as toolCalls.
   *  Empty on the final iteration (no calls). */
  toolResults: RecordedToolResult[];
}

export interface AgentTurn {
  /** The user message that triggered this agent.run() invocation. */
  userInput: string;
  /** The mode the user input would trigger. "/plan X" → "plan". */
  mode: "react" | "plan";
  /** LLM iterations within this turn, in order. */
  iterations: LLMIteration[];
}

export interface Tape {
  /** Source session id (or "synthesized:name") for diagnostics. */
  source: string;
  /** Agent turns in order. */
  turns: AgentTurn[];
}

const PLAN_PREFIX = "/plan ";

/**
 * Parse session entries into a Tape. Skips REPL-only slash commands like
 * `/exit` (no agent.run() was invoked for them). `/plan ...` is preserved as
 * a plan-mode turn with the `/plan ` prefix stripped.
 */
export function buildTape(entries: SessionEntry[], source: string): Tape {
  const turns: AgentTurn[] = [];
  let current: AgentTurn | null = null;
  let pendingIteration: LLMIteration | null = null;

  function startIteration(): LLMIteration {
    return { text: "", toolCalls: [], toolResults: [] };
  }

  function flushIteration(): void {
    if (pendingIteration && current) {
      current.iterations.push(pendingIteration);
    }
    pendingIteration = null;
  }

  function flushTurn(): void {
    flushIteration();
    if (current) turns.push(current);
    current = null;
  }

  for (const entry of entries) {
    if (entry.type === "session_start") continue;

    if (entry.type === "user") {
      // REPL-only commands never reach the agent — skip them. /plan triggers
      // a plan-mode agent.run() so it's kept.
      if (entry.content === "/exit" || entry.content === "/clear") continue;

      flushTurn();
      const isPlan = entry.content.startsWith(PLAN_PREFIX);
      current = {
        userInput: isPlan ? entry.content.slice(PLAN_PREFIX.length) : entry.content,
        mode: isPlan ? "plan" : "react",
        iterations: [],
      };
      pendingIteration = startIteration();
      continue;
    }

    if (!current || !pendingIteration) continue;

    if (entry.type === "tool_call") {
      // If this tool_call comes after results, we're entering a new iteration.
      if (pendingIteration.toolResults.length > 0) {
        flushIteration();
        pendingIteration = startIteration();
      }
      pendingIteration.toolCalls.push({
        name: entry.name,
        args: entry.args,
        ...(entry.thoughtSignature ? { thoughtSignature: entry.thoughtSignature } : {}),
      });
      continue;
    }

    if (entry.type === "tool_result") {
      pendingIteration.toolResults.push({
        name: entry.name,
        result: entry.result,
      });
      continue;
    }

    if (entry.type === "assistant") {
      // Trailing text closes the turn — attributes the accumulated text
      // to a final text-only iteration. (Real runtime would have spread
      // this text across iterations; replay collapses it because the
      // JSONL doesn't preserve the spread.)
      //
      // Empty content special-case: when the recorded turn ended with NO
      // text (turnText accumulated empty across one or more iterations),
      // the agent's empty-response-retry mechanism fired — calling
      // stream() a SECOND time before emitting done. Replay must pad
      // with one extra empty iteration to satisfy the retry path or the
      // TapeClient will exhaust mid-replay.
      flushIteration();
      pendingIteration = startIteration();
      pendingIteration.text = entry.content;
      flushIteration();
      if (entry.content === "") {
        pendingIteration = startIteration();
        flushIteration();
      }
      flushTurn();
      continue;
    }
  }

  flushTurn();
  return { source, turns };
}

/**
 * Parse a JSONL string into SessionEntry[], skipping malformed lines.
 * Mirrors the leniency of Session.resume() — malformed lines warn but don't
 * abort.
 */
export function parseJsonlString(content: string): SessionEntry[] {
  const out: SessionEntry[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as SessionEntry);
    } catch {
      // Skip malformed — matches Session.resume() leniency.
    }
  }
  return out;
}
