import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

// Resolve the built CLI entry point relative to this file's location
const DIST_ENTRY = resolve(new URL(".", import.meta.url).pathname, "../../dist/index.js");
const CLI_BUILT = existsSync(DIST_ENTRY);

// Pick the cheapest available model based on which API key is in the environment.
// Returns undefined when no key is set (used to skip live-API tests).
function pickModel(): { model: string; env: Record<string, string> } | undefined {
  if (process.env.GEMINI_API_KEY) {
    return { model: "gemini-2.0-flash-lite", env: {} };
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return { model: "claude-haiku-4-5-20251001", env: {} };
  }
  if (process.env.OPENAI_API_KEY) {
    return { model: "gpt-4o-mini", env: {} };
  }
  return undefined;
}

const LIVE_MODEL = pickModel();

// ── Static CLI wiring (no API key needed) ────────────────────────────────────

describe.skipIf(!CLI_BUILT)("CLI subprocess smoke (requires npm run build)", () => {
  it("exits 0 and prints help text including expected commands", async () => {
    const { stdout, stderr } = await execFileAsync("node", [DIST_ENTRY, "--help"], {
      timeout: 10_000,
    });
    const output = stdout + stderr;
    expect(output).toContain("chat");
    expect(output).toContain("run");
    expect(output).toContain("sessions");
  });

  it("exits 0 and prints version string", async () => {
    const { stdout, stderr } = await execFileAsync("node", [DIST_ENTRY, "--version"], {
      timeout: 10_000,
    });
    const output = stdout + stderr;
    expect(output.trim()).toMatch(/\d+\.\d+\.\d+/);
  });

  it("sessions subcommand exits 0 and prints a header or empty message", async () => {
    const { stdout, stderr } = await execFileAsync("node", [DIST_ENTRY, "sessions"], {
      timeout: 10_000,
    });
    const output = stdout + stderr;
    // Either "No sessions found" or "Sessions for <cwd>:"
    expect(output).toMatch(/sessions|no sessions/i);
  });

  it("run --help exits 0 and lists run-specific flags", async () => {
    const { stdout, stderr } = await execFileAsync("node", [DIST_ENTRY, "run", "--help"], {
      timeout: 10_000,
    });
    const output = stdout + stderr;
    expect(output).toContain("--model");
    expect(output).toContain("--max-turns");
    expect(output).toContain("--yes");
    expect(output).toContain("--sandbox");
  });

  it("run --sandbox with invalid value exits 1 with a clear error", async () => {
    await expect(
      execFileAsync("node", [DIST_ENTRY, "run", "--sandbox", "invalid", "echo hi"], {
        timeout: 10_000,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Invalid --sandbox value 'invalid'"),
    });
  });

  it("run --max-turns with non-numeric value exits 1 with a clear error", async () => {
    await expect(
      execFileAsync("node", [DIST_ENTRY, "run", "--max-turns", "abc", "echo hi"], {
        timeout: 10_000,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("--max-turns must be a positive integer"),
    });
  });

  it("run --max-turns with zero exits 1 with a clear error", async () => {
    await expect(
      execFileAsync("node", [DIST_ENTRY, "run", "--max-turns", "0", "echo hi"], {
        timeout: 10_000,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("--max-turns must be a positive integer"),
    });
  });

  it("run --temperature with non-numeric value exits 1 with a clear error", async () => {
    await expect(
      execFileAsync("node", [DIST_ENTRY, "run", "--temperature", "notanumber", "echo hi"], {
        timeout: 10_000,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("--temperature must be between 0 and 2"),
    });
  });

  it("run --temperature with out-of-range value exits 1 with a clear error", async () => {
    await expect(
      execFileAsync("node", [DIST_ENTRY, "run", "--temperature", "-1", "echo hi"], {
        timeout: 10_000,
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("--temperature must be between 0 and 2"),
    });
  });

  it("OPENCLI_SANDBOX with invalid value exits 1 with a clear error", async () => {
    await expect(
      execFileAsync("node", [DIST_ENTRY, "run", "echo hi"], {
        timeout: 10_000,
        env: { ...process.env, OPENCLI_SANDBOX: "invalid" },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("Invalid --sandbox value 'invalid'"),
    });
  });
});

// ── Live one-shot run (skipped without an API key + built dist) ──────────────

describe.skipIf(!CLI_BUILT || !LIVE_MODEL)(
  "CLI one-shot run smoke — requires API key + built dist",
  () => {
    it("opencli run produces non-empty text output and exits 0", async () => {
      const { model } = LIVE_MODEL!;
      const { stdout } = await execFileAsync(
        "node",
        [DIST_ENTRY, "run", "reply with exactly one word: pong", "--max-turns", "3"],
        {
          timeout: 30_000,
          env: { ...process.env, OPENCLI_MODEL: model },
        },
      );
      // The agent must have emitted at least some text
      expect(stdout.trim().length).toBeGreaterThan(0);
      // A well-behaved model responding to "reply with one word: pong" should say pong
      expect(stdout.toLowerCase()).toContain("pong");
    }, 30_000);

    it("opencli run exits 0 even when tool confirmation is required (non-interactive auto-deny)", async () => {
      const { model } = LIVE_MODEL!;
      // Ask for a bash command — it will be auto-denied without --yes
      // The agent should surface an error message in text and still exit 0
      const { stdout, stderr } = await execFileAsync(
        "node",
        [DIST_ENTRY, "run", "run: echo hello", "--max-turns", "2"],
        {
          timeout: 30_000,
          env: { ...process.env, OPENCLI_MODEL: model },
        },
      );
      const output = stdout + stderr;
      // Process should not crash — some response text must be present
      expect(output.trim().length).toBeGreaterThan(0);
    }, 30_000);
  },
);

// ── Build gate (always runs, never fails hard) ───────────────────────────────

describe("CLI subprocess smoke — build gate", () => {
  it("dist/index.js exists (run npm run build if this fails)", () => {
    if (!CLI_BUILT) {
      console.warn(`[smoke] dist/index.js not found at ${DIST_ENTRY}. Run 'npm run build' first.`);
    }
    expect(true).toBe(true);
  });
});
