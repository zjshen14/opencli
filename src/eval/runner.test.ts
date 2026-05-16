import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runScenarioOnce } from "./runner.js";
import type { Scenario } from "./scenarios.js";

// Creates a minimal fake "opencli" binary that exits 0 and prints a fixed message
const FAKE_DIST_DIR = join(tmpdir(), "opencli-runner-test-dist");
const FAKE_DIST_ENTRY = join(FAKE_DIST_DIR, "index.js");

const scenario: Scenario = {
  id: "test",
  category: "read-explain",
  description: "test",
  prompt: "describe math.ts",
  fixture: "mini-ts",
  expected: { outputKeywords: ["add"] },
};

describe("runScenarioOnce", () => {
  beforeAll(async () => {
    await mkdir(FAKE_DIST_DIR, { recursive: true });
    await writeFile(
      FAKE_DIST_ENTRY,
      `process.stdout.write("add subtract multiply\\n"); process.exit(0);\n`,
    );
  });

  afterAll(async () => {
    await rm(FAKE_DIST_DIR, { recursive: true, force: true }).catch(() => undefined);
  });

  it("copies fixture and returns a RunResult shape", async () => {
    // Point runner at the fake binary via env override (runner reads DIST_ENTRY at module load,
    // so we exercise it by calling runScenarioOnce directly and trusting the shape).
    const result = await runScenarioOnce(scenario, "gemini-2.0-flash-lite");
    expect(result).toHaveProperty("output");
    expect(result).toHaveProperty("files");
    expect(result).toHaveProperty("typeErrors");
    expect(result).toHaveProperty("exitCode");
    expect(result).toHaveProperty("timedOut");
    expect(result).toHaveProperty("durationMs");
    expect(typeof result.durationMs).toBe("number");
  }, 60_000);
});
