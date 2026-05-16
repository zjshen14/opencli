import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import type { Scenario } from "./scenarios.js";

const DIST_ENTRY = join(fileURLToPath(import.meta.url), "../../../dist/index.js");
const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "../fixtures");
const MAX_RETRIES = 2;

export const CLI_BUILT = existsSync(DIST_ENTRY);

export interface RunResult {
  output: string;
  files: Record<string, string | null>;
  typeErrors: string | null;
  exitCode: number;
  timedOut: boolean;
  durationMs: number;
}

export async function runScenario(
  scenario: Scenario,
  model: string,
): Promise<{ result: RunResult; score: "pass" | "partial" | "fail" }> {
  const { scoreScenario } = await import("./scorer.js");
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const result = await runScenarioOnce(scenario, model);
    const { score } = scoreScenario(scenario, result);
    if (score !== "fail") return { result, score };
    if (attempt === MAX_RETRIES) return { result, score: "fail" };
  }
  throw new Error("unreachable");
}

export async function runScenarioOnce(scenario: Scenario, model: string): Promise<RunResult> {
  const tmpDir = join(
    tmpdir(),
    `opencli-eval-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(tmpDir, { recursive: true });

  try {
    await cp(join(FIXTURES_DIR, scenario.fixture), tmpDir, { recursive: true });

    for (const [cmd, ...args] of [
      ["git", "init"],
      ["git", "-c", "user.email=eval@opencli", "-c", "user.name=eval", "add", "."],
      ["git", "-c", "user.email=eval@opencli", "-c", "user.name=eval", "commit", "-m", "fixture"],
    ]) {
      spawnSync(cmd, args, { cwd: tmpDir, stdio: "pipe" });
    }

    const cliArgs = [
      DIST_ENTRY,
      "run",
      scenario.prompt,
      "--model",
      model,
      "--yes",
      "--max-turns",
      "20",
      "--temperature",
      "0",
    ];
    if (!scenario.sandbox) cliArgs.push("--sandbox", "off");

    const start = Date.now();
    const proc = spawnSync("node", cliArgs, {
      cwd: tmpDir,
      env: process.env,
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const durationMs = Date.now() - start;

    const output = proc.stdout?.toString() ?? "";
    const exitCode = proc.status ?? -1;
    const timedOut = proc.signal === "SIGTERM";

    let typeErrors: string | null = null;
    const expectedFiles = Object.keys(scenario.expected.files ?? {});
    if (expectedFiles.length > 0 && scenario.category !== "read-explain") {
      const tsc = spawnSync(
        "npx",
        ["tsc", "--noEmit", "--project", join(tmpDir, "tsconfig.json")],
        {
          stdio: "pipe",
          timeout: 30_000,
        },
      );
      if (tsc.status !== 0) {
        typeErrors = tsc.stdout?.toString() ?? tsc.stderr?.toString() ?? "tsc failed";
      }
    }

    const files: Record<string, string | null> = {};
    for (const rel of expectedFiles) {
      try {
        files[rel] = await readFile(join(tmpDir, rel), "utf8");
      } catch {
        files[rel] = null;
      }
    }

    return { output, files, typeErrors, exitCode, timedOut, durationMs };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
