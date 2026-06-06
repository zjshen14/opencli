/**
 * TapeClient — an LLMClient that replays a recorded session instead of
 * calling a real provider.
 *
 * Behaviour: each `stream()` call yields the events that the LLM would have
 * emitted for the next recorded iteration — the text it streamed, the tool
 * calls it requested, then a terminating `done`. Input arguments (messages,
 * system instruction, tool defs) are ignored — we're testing the agent
 * loop's bookkeeping under the recorded trajectory, not asking the model to
 * re-decide.
 *
 * Side effect: each `stream()` call also pushes a snapshot of the agent's
 * message list onto `sentMessages` so replay tests can assert on what the
 * agent actually sent to "the LLM" on each iteration. This is the inspection
 * hook used in place of an `Agent.snapshotContext()` API — same information,
 * no agent.ts change required.
 *
 * Cursor advancement is global across all `agent.run()` invocations driven
 * from the same TapeClient — the harness creates one TapeClient per Tape
 * and drives multiple agent.run() calls (one per AgentTurn) against it.
 */
import type { LLMClient } from "../../providers/client.js";
import type { Message, StreamEvent, ToolDefinition } from "../../providers/types.js";
import type { Tape, LLMIteration } from "./tape.js";

export interface SentMessages {
  /** Zero-based agent-turn index. */
  turnIndex: number;
  /** Zero-based LLM-iteration index within the turn. */
  iterationIndex: number;
  /** Snapshot of `messages` arg passed to stream(). Deep-cloned so later
   *  context mutations don't retroactively change recorded snapshots. */
  messages: Message[];
}

export class TapeClient implements LLMClient {
  private flat: { iteration: LLMIteration; turnIndex: number; iterationIndex: number }[] = [];
  private cursor = 0;
  /** One entry per `stream()` call — recorded for inspection by tests. */
  readonly sentMessages: SentMessages[] = [];
  /** Synthetic id counter for function_call events. */
  private callIdCounter = 0;

  constructor(tape: Tape) {
    for (let t = 0; t < tape.turns.length; t++) {
      const turn = tape.turns[t];
      for (let i = 0; i < turn.iterations.length; i++) {
        this.flat.push({ iteration: turn.iterations[i], turnIndex: t, iterationIndex: i });
      }
    }
  }

  /** Where will the next stream() call's events come from? */
  peek(): { turnIndex: number; iterationIndex: number } | null {
    const entry = this.flat[this.cursor];
    return entry ? { turnIndex: entry.turnIndex, iterationIndex: entry.iterationIndex } : null;
  }

  async *stream(
    messages: Message[],
    _systemInstruction: string,
    _tools: ToolDefinition[],
  ): AsyncGenerator<StreamEvent> {
    const entry = this.flat[this.cursor++];
    if (!entry) {
      throw new Error(
        `TapeClient: tape exhausted at stream() call ${this.cursor} — the agent ` +
          `made more LLM calls than the recording contains. This usually means ` +
          `auto-compact fired during replay (good!) but the recorded trajectory ` +
          `continued past where the post-compact agent would.`,
      );
    }

    this.sentMessages.push({
      turnIndex: entry.turnIndex,
      iterationIndex: entry.iterationIndex,
      messages: structuredClone(messages),
    });

    const { iteration } = entry;
    if (iteration.text) {
      yield { type: "text", text: iteration.text };
    }
    for (const call of iteration.toolCalls) {
      yield {
        type: "function_call",
        id: `tape-${++this.callIdCounter}`,
        name: call.name,
        args: call.args,
        ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {}),
      };
    }
    yield { type: "done" };
  }

  /** True if every recorded iteration has been consumed. */
  exhausted(): boolean {
    return this.cursor >= this.flat.length;
  }

  /** Remaining iterations not yet replayed. */
  remaining(): number {
    return Math.max(0, this.flat.length - this.cursor);
  }
}
