/**
 * End-to-end replay tests for synthesised tapes — edge-case behaviours
 * the real card_trade tape doesn't exercise (guards, nested compaction).
 *
 * Two file-backed tapes live under `src/eval/replay-tapes/synthesized/`
 * (small enough to be human-inspectable on PR diff). The
 * nested-compaction case lives here as a programmatic tape because it
 * needs hundreds of KB of synthetic content to push the agent above
 * the auto-compact threshold twice — committing that to JSONL would
 * bloat the repo for no inspection value.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseJsonlString, buildTape } from "./tape.js";
import type { Tape, LLMIteration } from "./tape.js";
import { runTape } from "./runner.js";
import { countOfType, eventsOfType, compactStartedResolutions } from "./assertions.js";
import type { ObservabilityEvent } from "../../core/observability.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TAPES = join(HERE, "..", "replay-tapes", "synthesized");

interface Expected {
  source: string;
  tapeStats: { turns: number; totalIterations: number; totalToolCalls: number };
  observability: {
    exact: Partial<Record<ObservabilityEvent["type"], number>>;
  };
  cleanExit: { tapeExhausted: boolean; unconsumedResults: number };
  guards?: { guard: string; reasonContains: string }[];
}

function loadTape(name: string): { tape: Tape; expected: Expected } {
  const jsonl = readFileSync(join(TAPES, `${name}.jsonl`), "utf8");
  const expected = JSON.parse(
    readFileSync(join(TAPES, `${name}.expected.json`), "utf8"),
  ) as Expected;
  const entries = parseJsonlString(jsonl);
  const tape = buildTape(entries, name);
  return { tape, expected };
}

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

function assertExpected(
  observability: ObservabilityEvent[],
  unconsumedResults: number,
  tapeExhausted: boolean,
  expected: Expected,
): void {
  expect(tapeExhausted).toBe(expected.cleanExit.tapeExhausted);
  expect(unconsumedResults).toBe(expected.cleanExit.unconsumedResults);
  for (const [type, count] of Object.entries(expected.observability.exact)) {
    expect(
      countOfType(observability, type as ObservabilityEvent["type"]),
      `exact count for ${type}`,
    ).toBe(count);
  }
  for (const g of expected.guards ?? []) {
    const guards = eventsOfType(observability, "guard_triggered");
    const matched = guards.find((e) => e.guard === g.guard && e.reason.includes(g.reasonContains));
    expect(
      matched,
      `expected guard ${g.guard} with reason containing "${g.reasonContains}"`,
    ).toBeDefined();
  }
}

describe("synthesised replay — stuck-loop guard", () => {
  const { tape, expected } = loadTape("stuck-loop");

  it("parses to 1 turn × 3 iterations × 3 tool calls", () => {
    expect(tape.turns).toHaveLength(expected.tapeStats.turns);
    expect(tape.turns[0].iterations).toHaveLength(expected.tapeStats.totalIterations);
    const calls = tape.turns[0].iterations.reduce((a, i) => a + i.toolCalls.length, 0);
    expect(calls).toBe(expected.tapeStats.totalToolCalls);
  });

  it("fires guard_triggered('stuck_loop') after the third identical call", async () => {
    const r = await runTape(tape, { model: "fake-model" });
    assertExpected(r.observability, r.unconsumedResults, r.tapeExhausted, expected);
    // Iter 3 must abort BEFORE tool execution, so only iters 1+2 run tools.
    expect(r.executionLog.length).toBe(2);
  });
});

describe("synthesised replay — env-error-loop guard", () => {
  const { tape, expected } = loadTape("env-error-loop");

  it("parses to 1 turn × 3 iterations × 3 tool calls", () => {
    expect(tape.turns).toHaveLength(expected.tapeStats.turns);
    expect(tape.turns[0].iterations).toHaveLength(expected.tapeStats.totalIterations);
  });

  it("fires guard_triggered('env_error_loop') after EPERM appears in 3 consecutive turns", async () => {
    const r = await runTape(tape, { model: "fake-model" });
    assertExpected(r.observability, r.unconsumedResults, r.tapeExhausted, expected);
    // Unlike stuck-loop, env-error fires AFTER tool execution, so all 3
    // tool calls run.
    expect(r.executionLog.length).toBe(3);
  });

  it("does not also fire stuck_loop (args differ across iterations)", async () => {
    const r = await runTape(tape, { model: "fake-model" });
    const guards = eventsOfType(r.observability, "guard_triggered");
    expect(guards.map((g) => g.guard)).toEqual(["env_error_loop"]);
  });
});

describe("synthesised replay — nested compaction (programmatic, large payload)", () => {
  /** Three react-mode turns. Turn 1 fills context with 5 × 100 k char
   *  tool_results so post-first-compaction the tail (which always
   *  contains 4 large user-result messages by the time turn 3 begins)
   *  is still above the 75 k token threshold and a second auto-compact
   *  fires — that's the "nested" case where the original task block
   *  must survive an earlier summary. */
  function nestedTape(): Tape {
    const chunk = "x".repeat(100_000);
    const tools: LLMIteration[] = [];
    for (let i = 0; i < 5; i++) {
      tools.push(
        iter(
          "",
          [{ name: "read", args: { file_path: `f${i}.txt` } }],
          [{ name: "read", result: chunk }],
        ),
      );
    }
    return {
      source: "synth-nested-compaction",
      turns: [
        {
          userInput: "round 1: read the big files",
          mode: "react",
          iterations: [...tools, iter("done 1.")],
        },
        {
          userInput: "round 2: continue",
          mode: "react",
          iterations: [
            iter(
              "",
              [{ name: "read", args: { file_path: "small1" } }],
              [{ name: "read", result: "tiny" }],
            ),
            iter("done 2."),
          ],
        },
        {
          userInput: "round 3: keep going",
          mode: "react",
          iterations: [
            iter(
              "",
              [{ name: "read", args: { file_path: "small2" } }],
              [{ name: "read", result: "tiny" }],
            ),
            iter("done 3."),
          ],
        },
      ],
    };
  }

  it("fires compact_started TWICE (one nested), each paired with compact_completed", async () => {
    const r = await runTape(nestedTape(), { model: "fake-model" });
    expect(countOfType(r.observability, "compact_started")).toBe(2);
    expect(countOfType(r.observability, "compact_completed")).toBe(2);
    expect(countOfType(r.observability, "compact_failed")).toBe(0);
    const resolutions = compactStartedResolutions(r.observability);
    expect(resolutions).toHaveLength(2);
    for (const res of resolutions) {
      expect(res.resolved?.type).toBe("compact_completed");
      if (res.resolved?.type === "compact_completed") {
        expect(res.resolved.messagesRemoved).toBeGreaterThan(0);
      }
    }
  });

  it("preserves the original task across nested compactions (prune-anchor contract)", async () => {
    const r = await runTape(nestedTape(), { model: "fake-model" });
    // After 2 compactions, the LAST stream() call's `messages` arg must
    // still carry the original task — either inline as the first user
    // message or embedded in a summary message's verbatim block. We check
    // the simpler property: some message contains the literal user input
    // from turn 1.
    const last = r.sentMessages[r.sentMessages.length - 1];
    const concatText = last.messages
      .flatMap((m) => m.parts)
      .filter((p) => p.type === "text")
      .map((p) => (p as { type: "text"; text: string }).text)
      .join("\n");
    expect(concatText).toContain("round 1: read the big files");
  });

  it("the second compaction is provably nested — fires only after the first compaction completed", async () => {
    const r = await runTape(nestedTape(), { model: "fake-model" });
    const starts = r.observability
      .map((e, i) => ({ i, e }))
      .filter(({ e }) => e.type === "compact_started");
    expect(starts).toHaveLength(2);
    const firstCompletedIdx = r.observability.findIndex((e) => e.type === "compact_completed");
    expect(firstCompletedIdx).toBeGreaterThanOrEqual(0);
    expect(starts[1].i).toBeGreaterThan(firstCompletedIdx);
  });
});
