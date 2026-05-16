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
      if (expectation.notContains && content.includes(expectation.notContains)) ok = false;
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
