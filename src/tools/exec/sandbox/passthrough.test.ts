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

  it("unblocks within grace period when command backgrounds a process holding stdio", async () => {
    // Issue #151 repro: a backgrounded grandchild that doesn't redirect
    // stdin/stdout/stderr keeps the spawn's pipe FDs open. Before the fix,
    // the bash tool's Promise never resolved because `close` waited on those
    // pipes. With detached spawn + process-group kill on timeout, the tool
    // must unblock within (timeout + grace + force-resolve buffer).
    const start = Date.now();
    const result = await runner.exec("sleep 30 & echo started", {
      cwd: process.cwd(),
      timeout: 300,
    });
    const elapsed = Date.now() - start;
    // Must resolve well before the 30-second sleep finishes naturally.
    // Budget: 300ms timeout + 2000ms SIGTERM→SIGKILL grace + 500ms force
    // window + small slack.
    expect(elapsed).toBeLessThan(5000);
    // Either the shell exited cleanly after echo (the `close` event fired
    // because nothing inherited the pipes that lap), OR the timeout fired
    // and we forced detach. Both are acceptable — the test is about NOT
    // hanging past the 30s sleep.
    expect([0, -1]).toContain(result.exitCode);
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
