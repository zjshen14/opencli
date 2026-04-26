import { describe, it, expect, afterEach } from "vitest";
import { writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadSystemInstruction,
  DEFAULT_SYSTEM_INSTRUCTION,
  getGitContext,
  buildReminder,
} from "./prompt.js";

afterEach(() => {
  delete process.env.OPENCLI_SYSTEM_MD;
});

describe("loadSystemInstruction", () => {
  it("returns DEFAULT_SYSTEM_INSTRUCTION when OPENCLI_SYSTEM_MD is not set", async () => {
    const result = await loadSystemInstruction();
    expect(result).toBe(DEFAULT_SYSTEM_INSTRUCTION);
  });

  it("loads from file when OPENCLI_SYSTEM_MD is set", async () => {
    const path = join(tmpdir(), `prompt-test-${Date.now()}.md`);
    await writeFile(path, "Custom prompt for testing.");
    process.env.OPENCLI_SYSTEM_MD = path;

    const result = await loadSystemInstruction();
    expect(result).toBe("Custom prompt for testing.");

    await rm(path);
  });

  it("throws when OPENCLI_SYSTEM_MD points to a missing file", async () => {
    process.env.OPENCLI_SYSTEM_MD = "/nonexistent/path/prompt.md";
    await expect(loadSystemInstruction()).rejects.toThrow();
  });
});

describe("getGitContext", () => {
  it("returns a string without throwing", () => {
    const ctx = getGitContext();
    expect(typeof ctx).toBe("string");
  });

  it("returns either empty string or a well-formed Repository section", () => {
    const ctx = getGitContext();
    if (ctx) {
      expect(ctx).toContain("## Repository");
      expect(ctx).toContain("Branch:");
      expect(ctx).toContain("Status:");
    }
  });
});

describe("buildReminder", () => {
  it("returns empty string for read-only tool calls", () => {
    const calls = [
      { name: "read", args: {} },
      { name: "glob", args: {} },
      { name: "grep", args: {} },
    ];
    expect(buildReminder(calls)).toBe("");
  });

  it("fires test reminder after edit call", () => {
    const calls = [{ name: "edit", args: { file_path: "foo.ts" } }];
    const reminder = buildReminder(calls);
    expect(reminder).toContain("run tests after making code changes");
  });

  it("fires test reminder after write call", () => {
    const calls = [{ name: "write", args: { file_path: "foo.ts" } }];
    expect(buildReminder(calls)).toContain("run tests after making code changes");
  });

  it("fires git reminder only when bash command includes git", () => {
    const gitCall = [{ name: "bash", args: { command: "git status" } }];
    const nonGitCall = [{ name: "bash", args: { command: "npm test" } }];
    expect(buildReminder(gitCall)).toContain("never commit or push");
    expect(buildReminder(nonGitCall)).not.toContain("never commit or push");
  });

  it("combines multiple relevant reminders in one block", () => {
    const calls = [
      { name: "edit", args: {} },
      { name: "bash", args: { command: "git diff" } },
    ];
    const reminder = buildReminder(calls);
    expect(reminder).toContain("run tests after making code changes");
    expect(reminder).toContain("never commit or push");
    // Single [reminder: ...] block
    expect(reminder.split("[reminder:").length).toBe(2);
  });
});
