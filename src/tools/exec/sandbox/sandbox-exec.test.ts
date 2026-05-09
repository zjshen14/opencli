import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxExecRunner } from "./sandbox-exec.js";

const isMacOS = process.platform === "darwin";

describe.skipIf(!isMacOS)("SandboxExecRunner (macOS only)", () => {
  const runner = new SandboxExecRunner("auto", process.cwd());

  it("runs a simple echo command successfully", async () => {
    const result = await runner.exec("echo hello", { cwd: process.cwd() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
  });

  it("blocks network access (curl to example.com)", async () => {
    const result = await runner.exec("curl -s --max-time 5 https://example.com", {
      cwd: process.cwd(),
      timeout: 10_000,
    });
    expect(result.exitCode).not.toBe(0);
  });

  it("allows writes inside CWD", async () => {
    const testFile = join(process.cwd(), `.sandbox-test-${Date.now()}`);
    const result = await runner.exec(`touch "${testFile}" && rm "${testFile}"`, {
      cwd: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
  });

  it("blocks writes to /etc/hosts", async () => {
    const result = await runner.exec('echo "127.0.0.1 test" >> /etc/hosts', {
      cwd: process.cwd(),
    });
    expect(result.exitCode).not.toBe(0);
  });

  it("allows writes to /tmp", async () => {
    const testFile = join(tmpdir(), `.sandbox-test-${Date.now()}`);
    const result = await runner.exec(`touch "${testFile}" && rm "${testFile}"`, {
      cwd: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
  });
});
