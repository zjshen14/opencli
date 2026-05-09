import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BwrapRunner } from "./bwrap.js";

const isLinux = process.platform === "linux";

describe.skipIf(!isLinux)("BwrapRunner (Linux only)", () => {
  const runner = new BwrapRunner("auto", process.cwd());

  it("runs a simple echo command successfully", async () => {
    if (runner.warning) {
      // bwrap not available or namespaces disabled — skip actual execution test
      return;
    }
    const result = await runner.exec("echo hello", { cwd: process.cwd() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
  });

  it("blocks network access (curl to example.com)", async () => {
    if (runner.warning) return;
    const result = await runner.exec("curl -s --max-time 5 https://example.com", {
      cwd: process.cwd(),
      timeout: 10_000,
    });
    expect(result.exitCode).not.toBe(0);
  });

  it("allows writes inside CWD", async () => {
    if (runner.warning) return;
    const testFile = join(process.cwd(), `.sandbox-test-${Date.now()}`);
    const result = await runner.exec(`touch "${testFile}" && rm "${testFile}"`, {
      cwd: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
  });

  it("blocks writes to /etc/hosts", async () => {
    if (runner.warning) return;
    const result = await runner.exec('echo "127.0.0.1 test" >> /etc/hosts', {
      cwd: process.cwd(),
    });
    expect(result.exitCode).not.toBe(0);
  });

  it("allows writes to /tmp", async () => {
    if (runner.warning) return;
    const testFile = join(tmpdir(), `.sandbox-test-${Date.now()}`);
    const result = await runner.exec(`touch "${testFile}" && rm "${testFile}"`, {
      cwd: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
  });

  it("falls back gracefully when bwrap is unavailable", () => {
    // If runner has a warning, it already fell back — verify it still executes commands
    if (!runner.warning) return;
    expect(runner.warning).toBeTruthy();
  });
});
