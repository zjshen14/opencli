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

  it("unblocks promptly when command backgrounds a process holding stdio", async () => {
    // Issue #151 repro: a backgrounded grandchild that doesn't redirect
    // stdin/stdout/stderr keeps the spawn's pipe FDs open. Before the fix,
    // `close` couldn't fire and the bash tool's Promise hung forever.
    //
    // With `detached: true`, sleep stays in the shell's process group
    // after the shell exits. The timer at `timeout` ms then sends SIGTERM
    // to the process group via process.kill(-pid, ...). sleep dies, the
    // pipes close, `close` fires with timedOut=true → exitCode -1.
    //
    // (Note: there's no SIGHUP cascade here because stdio is piped, not a
    // controlling terminal — so session-leader-exit doesn't auto-signal
    // the background job. The timer is what actually kills sleep.)
    const start = Date.now();
    const result = await runner.exec("sleep 30 & echo started", {
      cwd: process.cwd(),
      timeout: 300,
    });
    const elapsed = Date.now() - start;
    // Must resolve well before the 30-second sleep finishes naturally.
    // Expected: ~300-500ms (timeout + signal latency).
    expect(elapsed).toBeLessThan(2000);
    expect(result.exitCode).toBe(-1);
    expect(result.stdout).toContain("started");
  }, 10_000);

  it("exposes mode and null warning", () => {
    expect(runner.mode).toBe("off");
    expect(runner.warning).toBeNull();
  });

  it("exposes warning string when provided", () => {
    const warned = new PassthroughRunner("auto", "test warning");
    expect(warned.warning).toBe("test warning");
  });
});
