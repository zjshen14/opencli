import { cp, mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";
import type { Scenario } from "./scenarios.js";

const DIST_ENTRY = join(fileURLToPath(import.meta.url), "../../../dist/index.js");
const FIXTURES_DIR = join(fileURLToPath(import.meta.url), "../fixtures");

const AGENT_TIMEOUT_MS = 240_000;
// No runner-level retries: the agent already retries internally (withRetry in providers).
// Retrying at this layer compounds rate-limit pressure without benefit.
// Re-enable if you observe transient non-rate-limit failures in CI.
const MAX_RETRIES = 0;

// Optional inter-scenario delay to stay within free-tier TPM limits.
// Set EVAL_SCENARIO_DELAY_MS=15000 when running against a free-tier key.
const SCENARIO_DELAY_MS = parseInt(process.env.EVAL_SCENARIO_DELAY_MS ?? "0", 10);

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
  if (SCENARIO_DELAY_MS > 0) await new Promise((r) => setTimeout(r, SCENARIO_DELAY_MS));
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const result = await runScenarioOnce(scenario, model);
    const { score } = scoreScenario(scenario, result);
    if (score !== "fail") return { result, score };
    if (attempt === MAX_RETRIES) return { result, score: "fail" };
  }
  throw new Error("unreachable");
}

/** Spawn a process and capture stdout, resolving when it exits or the signal fires. */
function spawnAsync(
  cmd: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal },
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));

    let timedOut = false;
    const onAbort = () => {
      timedOut = true;
      child.kill("SIGTERM");
      // Give it 5 s to exit cleanly, then SIGKILL
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    };
    opts.signal.addEventListener("abort", onAbort, { once: true });

    child.once("close", (code) => {
      opts.signal.removeEventListener("abort", onAbort);
      resolve({ stdout, stderr, exitCode: code ?? -1, timedOut });
    });
  });
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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);

    const start = Date.now();
    const proc = await spawnAsync("node", cliArgs, {
      cwd: tmpDir,
      env: process.env,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const durationMs = Date.now() - start;

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

    return {
      output: proc.stdout,
      files,
      typeErrors,
      exitCode: proc.exitCode,
      timedOut: proc.timedOut,
      durationMs,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}
