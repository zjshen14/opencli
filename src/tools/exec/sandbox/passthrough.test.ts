import { describe, it, expect } from "vitest";
import { PassthroughRunner } from "./passthrough.js";

describe("PassthroughRunner", () => {
  const runner = new PassthroughRunner("off");

  it("collects stdout", async () => {
    const result = await runner.exec("echo hello", { cwd: process.cwd() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
  });

  it("collects stderr", async () => {
    const result = await runner.exec("echo error >&2", { cwd: process.cwd() });
    expect(result.stderr).toContain("error");
  });

  it("returns non-zero exitCode on failure", async () => {
    const result = await runner.exec("exit 1", { cwd: process.cwd() });
    expect(result.exitCode).toBe(1);
  });

  it("returns exitCode -1 on timeout", async () => {
    const result = await runner.exec("sleep 60", { cwd: process.cwd(), timeout: 100 });
    expect(result.exitCode).toBe(-1);
  });

  it("resolves after timeout when a backgrounded child holds pipes open", async () => {
    // Reproduces: bash runs `sleep 60 &` — shell exits immediately but sleep
    // inherits the pipe FDs, so close() never fires without a group kill.
    const start = Date.now();
    const result = await runner.exec("sleep 60 &", { cwd: process.cwd(), timeout: 300 });
    expect(result.exitCode).toBe(-1);
    // Must resolve well within timeout + 2 s grace, not hang indefinitely.
    expect(Date.now() - start).toBeLessThan(5_000);
  });

  it("exposes mode and null warning", () => {
    expect(runner.mode).toBe("off");
    expect(runner.warning).toBeNull();
  });

  it("exposes warning string when provided", () => {
    const warned = new PassthroughRunner("auto", "test warning");
    expect(warned.warning).toBe("test warning");
  });
});
