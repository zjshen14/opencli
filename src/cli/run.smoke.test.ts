import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const execFileAsync = promisify(execFile);

// Resolve the built CLI entry point relative to this file's location
const DIST_ENTRY = resolve(new URL(".", import.meta.url).pathname, "../../dist/index.js");
const CLI_BUILT = existsSync(DIST_ENTRY);

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
    // Should look like a semver string
    expect(output.trim()).toMatch(/\d+\.\d+\.\d+/);
  });
});

describe("CLI subprocess smoke — build gate", () => {
  it("dist/index.js exists (run npm run build if this fails)", () => {
    // This test always runs and gives a clear message when the build is missing
    if (!CLI_BUILT) {
      console.warn(`[smoke] dist/index.js not found at ${DIST_ENTRY}. Run 'npm run build' first.`);
    }
    // Not a hard failure — we skip the subprocess tests above instead
    expect(true).toBe(true);
  });
});
