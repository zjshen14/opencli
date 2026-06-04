import { describe, it, expect } from "vitest";
import { globMatch, matchesDenyPattern, createForcesConfirmationFn } from "./confirm.js";

describe("globMatch", () => {
  it("matches an exact string with no wildcards", () => {
    expect(globMatch("git status", "git status")).toBe(true);
    expect(globMatch("git status", "git status --short")).toBe(false);
  });

  it("matches * as zero or more characters", () => {
    expect(globMatch("rm -rf *", "rm -rf /tmp")).toBe(true);
    expect(globMatch("rm -rf *", "rm -rf .")).toBe(true);
    expect(globMatch("rm -rf *", "rm -rf")).toBe(false); // trailing space required
    expect(globMatch("rm -rf*", "rm -rf")).toBe(true); // no space → * matches empty
  });

  it("escapes regex special chars in the pattern literally", () => {
    expect(globMatch("npm run test", "npm run test")).toBe(true);
    expect(globMatch("file.ts", "file.ts")).toBe(true);
    expect(globMatch("file.ts", "fileXts")).toBe(false); // dot is literal
  });

  it("supports leading wildcard", () => {
    expect(globMatch("*.ts", "foo.ts")).toBe(true);
    expect(globMatch("*.ts", "foo.js")).toBe(false);
  });
});

describe("matchesDenyPattern", () => {
  it("returns false when patterns list is empty", () => {
    expect(matchesDenyPattern([], "bash", { command: "rm -rf ." })).toBe(false);
  });

  it("matches bash command glob", () => {
    const patterns = ["bash(rm -rf *)"];
    expect(matchesDenyPattern(patterns, "bash", { command: "rm -rf /tmp" })).toBe(true);
    expect(matchesDenyPattern(patterns, "bash", { command: "rm /tmp" })).toBe(false);
  });

  it("matches all bash calls with bash(*)", () => {
    const patterns = ["bash(*)"];
    expect(matchesDenyPattern(patterns, "bash", { command: "ls -la" })).toBe(true);
    expect(matchesDenyPattern(patterns, "bash", { command: "git status" })).toBe(true);
  });

  it("does not match a different tool name", () => {
    const patterns = ["bash(rm -rf *)"];
    expect(matchesDenyPattern(patterns, "write", { file_path: "rm -rf /" })).toBe(false);
  });

  it("matches write patterns against file_path", () => {
    const patterns = ["write(src/cli/*)"];
    expect(matchesDenyPattern(patterns, "write", { file_path: "src/cli/index.ts" })).toBe(true);
    expect(matchesDenyPattern(patterns, "write", { file_path: "src/core/agent.ts" })).toBe(false);
  });

  it("matches edit patterns against file_path", () => {
    const patterns = ["edit(package.json)"];
    expect(matchesDenyPattern(patterns, "edit", { file_path: "package.json" })).toBe(true);
    expect(matchesDenyPattern(patterns, "edit", { file_path: "package-lock.json" })).toBe(false);
  });

  it("skips malformed patterns without parens", () => {
    const patterns = ["bash:git push"]; // legacy allow format — not valid for deny
    expect(matchesDenyPattern(patterns, "bash", { command: "git push" })).toBe(false);
  });

  it("skips patterns with no closing paren", () => {
    const patterns = ["bash(rm -rf *"];
    expect(matchesDenyPattern(patterns, "bash", { command: "rm -rf /" })).toBe(false);
  });

  it("matches first matching pattern in a list", () => {
    const patterns = ["write(*)", "bash(git push*)"];
    expect(matchesDenyPattern(patterns, "write", { file_path: "anything.ts" })).toBe(true);
    expect(matchesDenyPattern(patterns, "bash", { command: "git push origin main" })).toBe(true);
    expect(matchesDenyPattern(patterns, "bash", { command: "git status" })).toBe(false);
  });

  it("matches multi_edit patterns against file_path", () => {
    const patterns = ["multi_edit(.env*)"];
    expect(
      matchesDenyPattern(patterns, "multi_edit", {
        file_path: ".env",
        edits: [{ old_string: "a", new_string: "b" }],
      }),
    ).toBe(true);
    expect(
      matchesDenyPattern(patterns, "multi_edit", {
        file_path: "src/foo.ts",
        edits: [{ old_string: "a", new_string: "b" }],
      }),
    ).toBe(false);
  });

  it("uses JSON stringify for unknown tools", () => {
    const patterns = ['read({"file_path":"secret.txt"})'];
    expect(matchesDenyPattern(patterns, "read", { file_path: "secret.txt" })).toBe(true);
    expect(matchesDenyPattern(patterns, "read", { file_path: "other.txt" })).toBe(false);
  });
});

describe("createForcesConfirmationFn", () => {
  it("returns false for all calls when ask patterns list is empty", () => {
    const fn = createForcesConfirmationFn([]);
    expect(fn("bash", { command: "git status" })).toBe(false);
    expect(fn("write", { file_path: "src/foo.ts" })).toBe(false);
  });

  it("returns true when bash command matches an ask pattern", () => {
    const fn = createForcesConfirmationFn(["bash(git push*)"]);
    expect(fn("bash", { command: "git push origin main" })).toBe(true);
    expect(fn("bash", { command: "git status" })).toBe(false);
  });

  it("returns true when write path matches an ask pattern", () => {
    const fn = createForcesConfirmationFn(["write(src/*)"]);
    expect(fn("write", { file_path: "src/index.ts" })).toBe(true);
    expect(fn("write", { file_path: "test/index.ts" })).toBe(false);
  });

  it("returns true when multi_edit path matches an ask pattern", () => {
    const fn = createForcesConfirmationFn(["multi_edit(.env*)"]);
    expect(fn("multi_edit", { file_path: ".env", edits: [] })).toBe(true);
    expect(fn("multi_edit", { file_path: "src/foo.ts", edits: [] })).toBe(false);
  });

  it("returns false for a non-matching tool name", () => {
    const fn = createForcesConfirmationFn(["bash(git push*)"]);
    expect(fn("write", { command: "git push origin main" })).toBe(false);
  });

  it("matches across multiple patterns", () => {
    const fn = createForcesConfirmationFn(["bash(git push*)", "write(src/*)"]);
    expect(fn("bash", { command: "git push origin main" })).toBe(true);
    expect(fn("write", { file_path: "src/index.ts" })).toBe(true);
    expect(fn("bash", { command: "git status" })).toBe(false);
    expect(fn("write", { file_path: "test/index.ts" })).toBe(false);
  });
});
