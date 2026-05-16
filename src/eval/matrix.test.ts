/**
 * Full cross-provider matrix — runs real API calls against all 20 scenarios.
 * Requires: npm run build && at least one of ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY.
 *
 * Usage: npm run eval
 * With JSON artifact: EVAL_JSON_OUT=results.json npm run eval
 */
import { describe, it, expect, afterAll } from "vitest";
import { writeFileSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { configuredProviders, type Provider } from "./config.js";
import type { Scenario } from "./scenarios.js";
import { runScenario } from "./runner.js";
import { scoreScenario } from "./scorer.js";
import { formatMatrix } from "./report.js";

const DIST_ENTRY = join(fileURLToPath(import.meta.url), "../../../dist/index.js");
const SCENARIOS_DIR = join(fileURLToPath(import.meta.url), "../scenarios");

function loadScenariosSync(): Scenario[] {
  const files = readdirSync(SCENARIOS_DIR)
    .filter((f) => f.endsWith(".yaml"))
    .sort();
  return files.map((f) => parse(readFileSync(join(SCENARIOS_DIR, f), "utf8")) as Scenario);
}

function loadProvidersSync(): Provider[] {
  try {
    return configuredProviders();
  } catch {
    return [];
  }
}

if (!existsSync(DIST_ENTRY)) {
  it.skip("dist/index.js not found — run `npm run build` first", () => undefined);
} else {
  const providers = loadProvidersSync();
  const scenarios = loadScenariosSync();

  if (providers.length === 0) {
    it.skip("no API keys configured — set ANTHROPIC_API_KEY, GEMINI_API_KEY, or OPENAI_API_KEY", () =>
      undefined);
  } else {
    const matrix: Record<string, Record<string, string>> = {};

    describe.each(providers)("provider: $label ($model)", ({ label, model }) => {
      describe.each(scenarios)("$id", (scenario) => {
        it(scenario.description, { timeout: 400_000 }, async () => {
          const { result, score } = await runScenario(scenario, model);
          const { reason } = scoreScenario(scenario, result);
          matrix[scenario.id] ??= {};
          matrix[scenario.id][label] = score;
          if (score === "fail") {
            console.log(`[${label}] ${scenario.id} FAIL: ${reason}`);
          }
          expect(score, reason).not.toBe("fail");
        });
      });
    });

    afterAll(() => {
      if (Object.keys(matrix).length === 0) return;
      const providerLabels = providers.map((p) => p.label);
      const scenarioCategories = Object.fromEntries(scenarios.map((s) => [s.id, s.category]));
      const { markdown, json } = formatMatrix(matrix, scenarioCategories, providerLabels);
      console.log("\n" + markdown);
      const outPath = process.env.EVAL_JSON_OUT;
      if (outPath) writeFileSync(outPath, JSON.stringify(json, null, 2));
    });
  }
}
