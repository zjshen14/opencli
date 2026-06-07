/**
 * End-to-end replay tests against sealed real-session tapes. Drives an
 * Agent through the tape, captures the observability stream, and asserts
 * the shape of the captured events against a checked-in expected.json.
 *
 * If a refactor of the agent loop changes the event-emission pattern in a
 * way that matters (e.g. dropping a guard, double-firing a notice), the
 * delta lands in the diff for `expected.json` and shows up in PR review.
 * Run with `npm test -- replay.test.ts` to refresh expectations if a
 * change is deliberate.
 *
 * Tapes live under `src/eval/replay-tapes/`. The `.about.md` sidecar for
 * each tape documents what trajectory the tape captures and what makes it
 * useful.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseJsonlString, buildTape } from "./tape.js";
import { runTape } from "./runner.js";
import { countOfType } from "./assertions.js";
import type { ObservabilityEvent } from "../../core/observability.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TAPES = join(HERE, "..", "replay-tapes");

interface Expected {
  source: string;
  tapeStats: {
    turns: number;
    totalIterations: number;
    totalToolCalls: number;
  };
  observability: {
    /** Required exact counts. Use these for events whose count must be
     *  stable across refactors. */
    exact: Partial<Record<ObservabilityEvent["type"], number>>;
    /** Inclusive bounds for events whose exact count is implementation-
     *  detail-sensitive (e.g. context_snapshot count == llm iteration count;
     *  if either changes by 1 due to a benign refactor the test should
     *  still pass). */
    bounds?: Partial<Record<ObservabilityEvent["type"], { min: number; max: number }>>;
  };
  /** True iff the tape was exhausted with no leftover results. Always
   *  true for a well-formed real tape. */
  cleanExit: { tapeExhausted: boolean; unconsumedResults: number };
}

function loadTape(name: string): { tape: ReturnType<typeof buildTape>; expected: Expected } {
  const jsonl = readFileSync(join(TAPES, `${name}.jsonl`), "utf8");
  const expected = JSON.parse(
    readFileSync(join(TAPES, `${name}.expected.json`), "utf8"),
  ) as Expected;
  const entries = parseJsonlString(jsonl);
  const tape = buildTape(entries, name);
  return { tape, expected };
}

describe("replay — card-trade-2026-05-17 (truncated to clean react-mode stretch)", () => {
  const { tape, expected } = loadTape("card-trade-2026-05-17");

  it("parses to the recorded turn/iteration/tool-call shape", () => {
    expect(tape.turns.length).toBe(expected.tapeStats.turns);
    const iters = tape.turns.reduce((a, t) => a + t.iterations.length, 0);
    expect(iters).toBe(expected.tapeStats.totalIterations);
    const calls = tape.turns.reduce(
      (a, t) => a + t.iterations.reduce((b, i) => b + i.toolCalls.length, 0),
      0,
    );
    expect(calls).toBe(expected.tapeStats.totalToolCalls);
  });

  it(
    "replays end-to-end with the expected observability stream and clean exit",
    { timeout: 30_000 },
    async () => {
      const r = await runTape(tape, { model: "fake-model" });

      expect(r.tapeExhausted).toBe(expected.cleanExit.tapeExhausted);
      expect(r.unconsumedResults).toBe(expected.cleanExit.unconsumedResults);

      for (const [type, count] of Object.entries(expected.observability.exact)) {
        expect(
          countOfType(r.observability, type as ObservabilityEvent["type"]),
          `exact count for ${type}`,
        ).toBe(count);
      }

      for (const [type, range] of Object.entries(expected.observability.bounds ?? {})) {
        const c = countOfType(r.observability, type as ObservabilityEvent["type"]);
        expect(c, `${type} count ${c} not in [${range.min}, ${range.max}]`).toBeGreaterThanOrEqual(
          range.min,
        );
        expect(c, `${type} count ${c} not in [${range.min}, ${range.max}]`).toBeLessThanOrEqual(
          range.max,
        );
      }
    },
  );
});
