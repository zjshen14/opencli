import { describe, it, expect } from "vitest";
import { bashTool } from "./bash.js";

describe("bashTool", () => {
  it("executes a simple command and returns stdout", async () => {
    const result = await bashTool.execute({ command: "echo hello" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("hello");
  });

  it("captures stderr in output", async () => {
    const result = await bashTool.execute({ command: "echo error >&2" });
    expect(result.output).toContain("error");
  });

  it("returns success: false for non-zero exit code", async () => {
    const result = await bashTool.execute({ command: "exit 1" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Exited with code 1/);
  });

  it("respects cwd option", async () => {
    const result = await bashTool.execute({ command: "pwd", cwd: "/tmp" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("/tmp");
  });

  it("blocks rm -rf", async () => {
    const result = await bashTool.execute({ command: "rm -rf /tmp/something" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/destructive/);
  });

  it("blocks git push --force", async () => {
    const result = await bashTool.execute({ command: "git push --force origin main" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/destructive/);
  });

  it("blocks git reset --hard", async () => {
    const result = await bashTool.execute({ command: "git reset --hard HEAD~1" });
    expect(result.success).toBe(false);
  });

  it("runs multi-statement commands", async () => {
    const result = await bashTool.execute({ command: "echo foo && echo bar" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("foo");
    expect(result.output).toContain("bar");
  });
});
