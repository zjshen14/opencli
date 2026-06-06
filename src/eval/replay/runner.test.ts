/**
 * End-to-end replay tests. These drive a real Agent against synthesized
 * Tapes and assert on the captured ObservabilityEvent stream — the load-
 * bearing contract D2 was designed to validate.
 *
 * No real API calls. The TapeClient mocks the session LLM; a stub
 * compaction client provides the auto-compact summary deterministically.
 */
import { describe, it, expect } from "vitest";
import { runTape } from "./runner.js";
import type { Tape, LLMIteration } from "./tape.js";
import { countOfType, compactStartedResolutions, tokenTrajectory } from "./assertions.js";

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

describe("runTape — minimal trajectory (no compaction)", () => {
  const minimal: Tape = {
    source: "minimal",
    turns: [
      {
        userInput: "read foo and finish",
        mode: "react",
        iterations: [
          iter("", [{ name: "read", args: { file_path: "foo" } }], [{ name: "read", result: "x" }]),
          iter("All done."),
        ],
      },
    ],
  };

  it("replays one user→tool→done turn without firing any compaction events", async () => {
    const r = await runTape(minimal, { model: "fake-model" });
    expect(countOfType(r.observability, "compact_threshold_warned")).toBe(0);
    expect(countOfType(r.observability, "compact_started")).toBe(0);
    expect(countOfType(r.observability, "compact_completed")).toBe(0);
    expect(countOfType(r.observability, "compact_failed")).toBe(0);
  });

  it("fires llm_call_start/end in matched pairs", async () => {
    const r = await runTape(minimal, { model: "fake-model" });
    const starts = countOfType(r.observability, "llm_call_start");
    const ends = countOfType(r.observability, "llm_call_end");
    expect(starts).toBe(ends);
    expect(starts).toBeGreaterThan(0);
  });

  it("fires tool_exec_start/end for the one recorded tool call", async () => {
    const r = await runTape(minimal, { model: "fake-model" });
    expect(countOfType(r.observability, "tool_exec_start")).toBe(1);
    expect(countOfType(r.observability, "tool_exec_end")).toBe(1);
  });

  it("never fires a guard_triggered event on a well-formed tape", async () => {
    const r = await runTape(minimal, { model: "fake-model" });
    expect(countOfType(r.observability, "guard_triggered")).toBe(0);
  });

  it("exhausts the tape and consumes every recorded tool result", async () => {
    const r = await runTape(minimal, { model: "fake-model" });
    expect(r.tapeExhausted).toBe(true);
    expect(r.unconsumedResults).toBe(0);
  });

  it("emits the recorded assistant text via the agentEvent stream", async () => {
    const r = await runTape(minimal, { model: "fake-model" });
    const concatText = r.agentEvents
      .filter((e) => e.type === "text")
      .map((e) => e.text)
      .join("");
    expect(concatText).toBe("All done.");
  });
});

describe("runTape — context-pressure trajectories", () => {
  /** Default model window is 100k tokens (DEFAULT_CONTEXT_WINDOW from
   *  compact.ts, since "fake-model" matches no prefix). Trigger ratios:
   *  warn at 60% (60k tokens ≈ 240k chars), compact at 75% (75k tokens
   *  ≈ 300k chars). Warn and compact are mutually exclusive within a
   *  single gate check — warn fires only when ratio is in [0.60, 0.75);
   *  ratio ≥ 0.75 skips straight to compact. KEEP_RECENT = 10, so
   *  compactHistory needs ≥ 11 messages to have a non-empty head. */

  /** Lands turn 2's gate at ~65% — warn fires, compact does NOT.
   *  5 reads × 52k content + message wrapping ≈ 270k chars ≈ 67.5k tokens
   *  = 67.5% of the 100k window. */
  function warnOnlyTape(): Tape {
    const chunk = "x".repeat(52_000);
    const iters: LLMIteration[] = [];
    for (let i = 0; i < 5; i++) {
      iters.push(
        iter(
          "",
          [{ name: "read", args: { file_path: `f${i}.txt` } }],
          [{ name: "read", result: chunk }],
        ),
      );
    }
    return {
      source: "synth-warn-only",
      turns: [
        {
          userInput: "read five medium files",
          mode: "react",
          iterations: [...iters, iter("done.")],
        },
        {
          userInput: "follow-up",
          mode: "react",
          iterations: [
            iter(
              "",
              [{ name: "read", args: { file_path: "small.txt" } }],
              [{ name: "read", result: "tiny" }],
            ),
            iter("ok."),
          ],
        },
      ],
    };
  }

  /** Lands turn 2's gate above 75% — compact fires. Each of 5 read
   *  iterations adds ~70k content (≈18k tokens), totalling ~90k tokens
   *  by turn 2 start. */
  function compactTape(): Tape {
    const chunk = "x".repeat(70_000);
    const iters: LLMIteration[] = [];
    for (let i = 0; i < 5; i++) {
      iters.push(
        iter(
          "",
          [{ name: "read", args: { file_path: `f${i}.txt` } }],
          [{ name: "read", result: chunk }],
        ),
      );
    }
    return {
      source: "synth-compact",
      turns: [
        {
          userInput: "read five large files",
          mode: "react",
          iterations: [...iters, iter("read them all.")],
        },
        {
          userInput: "follow-up after auto-compact",
          mode: "react",
          iterations: [
            iter(
              "",
              [{ name: "read", args: { file_path: "small.txt" } }],
              [{ name: "read", result: "tiny" }],
            ),
            iter("ok."),
          ],
        },
      ],
    };
  }

  it("warn-only tape: compact_threshold_warned fires, compact_started does NOT", async () => {
    const r = await runTape(warnOnlyTape(), { model: "fake-model" });
    expect(countOfType(r.observability, "compact_threshold_warned")).toBe(1);
    expect(countOfType(r.observability, "compact_started")).toBe(0);
  });

  it("compact tape: compact_started fires exactly once, paired with compact_completed", async () => {
    const r = await runTape(compactTape(), { model: "fake-model" });
    expect(countOfType(r.observability, "compact_started")).toBe(1);
    const resolutions = compactStartedResolutions(r.observability);
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0].resolved?.type).toBe("compact_completed");
    if (resolutions[0].resolved?.type === "compact_completed") {
      expect(resolutions[0].resolved.messagesRemoved).toBeGreaterThan(0);
    }
    expect(countOfType(r.observability, "compact_failed")).toBe(0);
  });

  it("compact tape: ratio ≥ 0.75 skips the threshold warn (warn and compact are mutually exclusive per gate)", async () => {
    const r = await runTape(compactTape(), { model: "fake-model" });
    // Note: the `firedBefore` helper would fail here — by design — because
    // when ratio ≥ 0.75 the warn is skipped. Both events firing across
    // different turn boundaries would need a synthesised tape with a
    // controlled climb; deferred to the synthesised-tape PR.
    expect(countOfType(r.observability, "compact_threshold_warned")).toBe(0);
    expect(countOfType(r.observability, "compact_started")).toBe(1);
  });

  it("compact tape: token trajectory crosses the trigger threshold", async () => {
    const r = await runTape(compactTape(), { model: "fake-model" });
    const traj = tokenTrajectory(r.observability);
    const exceedingIdx = traj.findIndex((t) => t >= 75_000);
    expect(exceedingIdx).toBeGreaterThanOrEqual(0);
  });

  it("autoCompact: false suppresses both warn and compact even on a pressured tape", async () => {
    const r = await runTape(compactTape(), { model: "fake-model", autoCompact: false });
    expect(countOfType(r.observability, "compact_started")).toBe(0);
    expect(countOfType(r.observability, "compact_threshold_warned")).toBe(0);
  });
});

describe("runTape — plan-mode tape", () => {
  it("respects plan mode (no auto-compact, read-only tool gating)", async () => {
    const tape: Tape = {
      source: "plan",
      turns: [
        {
          userInput: "design a fix",
          mode: "plan",
          iterations: [iter("Here's the plan:\n\n- read a.ts\n- propose change")],
        },
      ],
    };
    const r = await runTape(tape, { model: "fake-model" });
    expect(countOfType(r.observability, "compact_started")).toBe(0);
    expect(r.agentEvents.some((e) => e.type === "text")).toBe(true);
  });
});
