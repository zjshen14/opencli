import type { Scenario } from "./scenarios.js";
import type { RunResult } from "./runner.js";

export interface ScoreResult {
  score: "pass" | "partial" | "fail";
  reason: string;
}

export function scoreScenario(scenario: Scenario, result: RunResult): ScoreResult {
  if (result.timedOut) return { score: "fail", reason: "timed out after 120s" };
  if (result.exitCode !== 0 && scenario.category !== "read-explain") {
    return { score: "fail", reason: `agent exited with code ${result.exitCode}` };
  }

  if (result.typeErrors) {
    return { score: "fail", reason: `tsc errors: ${result.typeErrors.slice(0, 200)}` };
  }

  const { outputKeywords, files } = scenario.expected;

  if (outputKeywords && outputKeywords.length > 0) {
    const missing = outputKeywords.filter((kw) => !result.output.includes(kw));
    if (missing.length > 0) {
      return { score: "fail", reason: `missing keywords: ${missing.join(", ")}` };
    }
    return { score: "pass", reason: "all output keywords found" };
  }

  if (files) {
    const entries = Object.entries(files);
    let passed = 0;

    for (const [path, expectation] of entries) {
      const content = result.files[path];

      if (expectation.exists === false) {
        if (content === null) {
          passed++;
          continue;
        }
        continue;
      }

      if (content === null) continue;

      let ok = true;
      if (expectation.contains) {
        const checks = Array.isArray(expectation.contains)
          ? expectation.contains
          : [expectation.contains];
        if (!checks.every((s) => content.includes(s))) ok = false;
      }
      if (expectation.notContains) {
        // A `notContains` match is only meaningful if it represents a
        // genuine occurrence of the forbidden pattern — not a substring of
        // a permitted `contains` match. Example: contains '=== ""',
        // notContains '== ""' — the correctly-fixed code matches both
        // because `==` is inside `===`. A naive substring check would
        // false-fail the fix.
        //
        // Two-step semantics:
        //   1. Find every range in the file where a `contains` pattern hits.
        //   2. A `notContains` hit only fails the score if its range is NOT
        //      fully covered by any `contains` range.
        // This rejects the case where the forbidden pattern extends beyond a
        // permitted match (the original `fix-off-by-one` behaviour: file has
        // `return this._count - 1;`, contains `return this._count` covers
        // [0, 18], notContains `this._count - 1` spans [7, 22] — 22 > 18, so
        // the match extends beyond and the score correctly fails).
        const ncRanges = findAllOccurrences(content, expectation.notContains);
        if (ncRanges.length > 0) {
          const containsList = expectation.contains
            ? Array.isArray(expectation.contains)
              ? expectation.contains
              : [expectation.contains]
            : [];
          const containsRanges = containsList.flatMap((c) => findAllOccurrences(content, c));

          const hasUncoveredMatch = ncRanges.some(
            ([ncStart, ncEnd]) =>
              !containsRanges.some(([cStart, cEnd]) => cStart <= ncStart && cEnd >= ncEnd),
          );
          if (hasUncoveredMatch) ok = false;
        }
      }
      if (ok) passed++;
    }

    if (passed === entries.length) return { score: "pass", reason: "all file checks passed" };
    if (entries.length > 1 && passed / entries.length >= 0.5) {
      return { score: "partial", reason: `${passed}/${entries.length} file checks passed` };
    }
    return { score: "fail", reason: `${passed}/${entries.length} file checks passed` };
  }

  return { score: "pass", reason: "no criteria to check" };
}

/**
 * Find all (start, end) ranges where `needle` occurs in `haystack`. Returns an
 * empty array if `needle` is empty. Advances by one character per iteration so
 * overlapping occurrences are reported (e.g. "aaa" contains "aa" at positions
 * 0 AND 1).
 */
function findAllOccurrences(haystack: string, needle: string): Array<[number, number]> {
  if (!needle) return [];
  const ranges: Array<[number, number]> = [];
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    ranges.push([idx, idx + needle.length]);
    idx += 1;
  }
  return ranges;
}
