import { describe, it, expect } from "vitest";
import { globMatch, matchesDenyPattern } from "./confirm.js";

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

  it("uses JSON stringify for unknown tools", () => {
    const patterns = ['read({"file_path":"secret.txt"})'];
    expect(matchesDenyPattern(patterns, "read", { file_path: "secret.txt" })).toBe(true);
    expect(matchesDenyPattern(patterns, "read", { file_path: "other.txt" })).toBe(false);
  });
});
