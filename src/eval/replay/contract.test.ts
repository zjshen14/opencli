/**
 * D2 contract evals — plan-mode and HITL surfaces.
 *
 * Plan-mode contract: assert that when agent.run() receives mode="plan",
 * the executor denies write-tool calls (tool_denied reason="plan_mode")
 * before they reach the registry. Tests two layers of the plan-mode defence:
 *   1. Executor readOnly guard — verified here via tool_denied events.
 *   2. Tool-definition filtering — write is absent from toolDefinitions sent
 *      to the LLM in plan mode; the TapeClient ignores toolDefs so this layer
 *      is not directly assertable from replay, but the executor layer is the
 *      stronger safety property.
 *
 * HITL contract: assert that tool_denied fires with the correct reason when
 * a tool is gated behind a confirmFn:
 *   - "user_denied"    — confirmFn present, returns "deny"
 *   - "non_interactive" — no confirmFn (headless / non-interactive context)
 *   - tool allowed     — confirmFn present, returns "allow" → tool executes normally
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseJsonlString, buildTape } from "./tape.js";
import type { Tape, LLMIteration } from "./tape.js";
import { runTape } from "./runner.js";
import { countOfType, eventsOfType } from "./assertions.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TAPES = join(HERE, "..", "replay-tapes", "synthesized");

function iter(
  text: string,
  toolCalls: { name: string; args?: Record<string, unknown> }[] = [],
  toolResults: { name: string; result: string }[] = [],
): LLMIteration {
  return {
    text,
    toolCalls: toolCalls.map((c) => ({ name: c.name, args: c.args ?? {} })),
    toolResults,
  };
}

// ---------------------------------------------------------------------------
// Plan-mode contract eval
// ---------------------------------------------------------------------------

describe("plan-mode contract — executor blocks write tools", () => {
  const jsonl = readFileSync(join(TAPES, "plan-mode-write-block.jsonl"), "utf8");
  const entries = parseJsonlString(jsonl);
  const tape = buildTape(entries, "plan-mode-write-block");

  it("tape parses to 1 plan-mode turn × 2 iterations × 1 tool call", () => {
    expect(tape.turns).toHaveLength(1);
    expect(tape.turns[0].mode).toBe("plan");
    expect(tape.turns[0].iterations).toHaveLength(2);
    expect(tape.turns[0].iterations[0].toolCalls).toHaveLength(1);
    expect(tape.turns[0].iterations[0].toolCalls[0].name).toBe("write");
  });

  it("fires tool_denied(plan_mode) for the write call and never executes it", async () => {
    const r = await runTape(tape, { model: "fake-model" });

    const denied = eventsOfType(r.observability, "tool_denied");
    expect(denied).toHaveLength(1);
    expect(denied[0].name).toBe("write");
    expect(denied[0].reason).toBe("plan_mode");

    // write must not reach the registry
    expect(countOfType(r.observability, "tool_exec_start")).toBe(0);
    expect(countOfType(r.observability, "tool_exec_end")).toBe(0);
    expect(r.executionLog).toHaveLength(0);
  });

  it("completes the tape cleanly — both LLM iterations consumed, no queued results left", async () => {
    const r = await runTape(tape, { model: "fake-model" });
    expect(r.tapeExhausted).toBe(true);
    expect(r.unconsumedResults).toBe(0);
    expect(countOfType(r.observability, "llm_call_start")).toBe(2);
  });

  it("no guards fire (write denial is not a guard — it is executor enforcement)", async () => {
    const r = await runTape(tape, { model: "fake-model" });
    expect(countOfType(r.observability, "guard_triggered")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// HITL contract evals
// ---------------------------------------------------------------------------

function hitlTape(includeResult: boolean): Tape {
  const callIter = iter(
    "",
    [{ name: "bash", args: { command: "echo hello" } }],
    includeResult ? [{ name: "bash", result: "hello" }] : [],
  );
  return {
    source: includeResult ? "synth-hitl-allow" : "synth-hitl-deny",
    turns: [
      {
        userInput: "run a command",
        mode: "react",
        iterations: [callIter, iter("Done.")],
      },
    ],
  };
}

describe("HITL contract — confirmFn deny → tool_denied(user_denied)", () => {
  it("fires tool_denied(user_denied) and does not execute the tool", async () => {
    const r = await runTape(hitlTape(false), {
      model: "fake-model",
      forcesConfirmation: (name) => name === "bash",
      confirmFn: async () => "deny",
    });

    const denied = eventsOfType(r.observability, "tool_denied");
    expect(denied).toHaveLength(1);
    expect(denied[0].name).toBe("bash");
    expect(denied[0].reason).toBe("user_denied");

    expect(countOfType(r.observability, "tool_exec_start")).toBe(0);
    expect(r.executionLog).toHaveLength(0);
  });

  it("tape exhausted cleanly — denial result feeds back to LLM for the second iteration", async () => {
    const r = await runTape(hitlTape(false), {
      model: "fake-model",
      forcesConfirmation: (name) => name === "bash",
      confirmFn: async () => "deny",
    });
    expect(r.tapeExhausted).toBe(true);
    expect(r.unconsumedResults).toBe(0);
  });
});

describe("HITL contract — no confirmFn (non-interactive) → tool_denied(non_interactive)", () => {
  it("fires tool_denied(non_interactive) when confirmFn is absent", async () => {
    const r = await runTape(hitlTape(false), {
      model: "fake-model",
      forcesConfirmation: (name) => name === "bash",
      // intentionally no confirmFn
    });

    const denied = eventsOfType(r.observability, "tool_denied");
    expect(denied).toHaveLength(1);
    expect(denied[0].name).toBe("bash");
    expect(denied[0].reason).toBe("non_interactive");
  });
});

describe("HITL contract — confirmFn allow → tool executes normally", () => {
  it("does not fire tool_denied and executes the tool when confirmFn returns allow", async () => {
    const r = await runTape(hitlTape(true), {
      model: "fake-model",
      forcesConfirmation: (name) => name === "bash",
      confirmFn: async () => "allow",
    });

    expect(countOfType(r.observability, "tool_denied")).toBe(0);
    expect(countOfType(r.observability, "tool_exec_start")).toBe(1);
    expect(r.executionLog).toHaveLength(1);
    expect(r.executionLog[0].name).toBe("bash");
  });

  it("tape exhausted cleanly", async () => {
    const r = await runTape(hitlTape(true), {
      model: "fake-model",
      forcesConfirmation: (name) => name === "bash",
      confirmFn: async () => "allow",
    });
    expect(r.tapeExhausted).toBe(true);
    expect(r.unconsumedResults).toBe(0);
  });
});
