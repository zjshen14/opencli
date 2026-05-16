// promptfoo custom provider — shells out to `node dist/index.js run` in a temp fixture dir.
// Returns a JSON object as `output` so type:javascript assertions can access
// both the agent's text output and the resulting filesystem state.

"use strict";

const { spawnSync, execFileSync } = require("child_process");
const { mkdtempSync, cpSync, readFileSync, rmSync } = require("fs");
const { join, resolve } = require("path");
const { tmpdir } = require("os");

const ROOT = resolve(__dirname, "..");
const DIST_ENTRY = join(ROOT, "dist", "index.js");
const FIXTURES_DIR = join(__dirname, "fixtures");

// Scenarios that should run with default sandbox instead of --sandbox off
const SANDBOX_AUTO = new Set(["explain-math-module", "fix-off-by-one"]);

class OpenCliProvider {
  constructor(options = {}) {
    this.options = options;
  }

  id() {
    return "opencli";
  }

  async callApi(prompt, context) {
    const vars = context.vars ?? {};
    const fixture = vars.fixture ?? "mini-ts";
    const model = vars.model ?? process.env.EVAL_MODEL ?? "gemini-2.0-flash-lite";
    const expectFiles = vars.expectFiles ?? [];
    const scenarioId = vars.scenarioId ?? "";

    // Create isolated temp dir and copy fixture into it
    const tmpDir = mkdtempSync(join(tmpdir(), "opencli-eval-"));
    try {
      cpSync(join(FIXTURES_DIR, fixture), tmpDir, { recursive: true });

      // Init git so snapshot/rewind features don't error in the agent
      for (const cmd of [
        ["git", "init"],
        ["git", "-c", "user.email=eval@opencli", "-c", "user.name=eval", "add", "."],
        [
          "git",
          "-c",
          "user.email=eval@opencli",
          "-c",
          "user.name=eval",
          "commit",
          "-m",
          "fixture",
        ],
      ]) {
        execFileSync(cmd[0], cmd.slice(1), { cwd: tmpDir, stdio: "pipe" });
      }

      // Build CLI invocation
      const cliArgs = [DIST_ENTRY, "run", prompt, "--model", model, "--yes", "--max-turns", "20"];
      if (!SANDBOX_AUTO.has(scenarioId)) {
        cliArgs.push("--sandbox", "off");
      }

      const result = spawnSync("node", cliArgs, {
        cwd: tmpDir,
        env: process.env,
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      });

      const agentOutput = result.stdout?.toString() ?? "";
      const exitCode = result.status ?? -1;

      // TypeScript compilation gate (only meaningful for code-modifying scenarios)
      let typeCheckOk = true;
      let typeErrors = null;
      if (expectFiles.length > 0) {
        const tsc = spawnSync(
          "npx",
          ["tsc", "--noEmit", "--project", join(tmpDir, "tsconfig.json")],
          { stdio: "pipe", timeout: 30_000 },
        );
        typeCheckOk = tsc.status === 0;
        if (!typeCheckOk) {
          typeErrors = tsc.stdout?.toString() ?? tsc.stderr?.toString() ?? "tsc failed";
        }
      }

      // Read file states for assertion
      const files = {};
      for (const rel of expectFiles) {
        try {
          files[rel] = readFileSync(join(tmpDir, rel), "utf8");
        } catch {
          files[rel] = null;
        }
      }

      return {
        output: {
          agentOutput,
          files,
          typeCheckOk,
          typeErrors,
          exitCode,
          timedOut: result.signal === "SIGTERM",
        },
      };
    } finally {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // non-fatal
      }
    }
  }
}

module.exports = OpenCliProvider;
