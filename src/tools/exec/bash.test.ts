import { describe, it, expect } from "vitest";
import { createBashTool } from "./bash.js";
import { PassthroughRunner } from "./sandbox/passthrough.js";

const bashTool = createBashTool(new PassthroughRunner("off"));

describe("bashTool.execute", () => {
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

  it("respects cwd option inside project root", async () => {
    const result = await bashTool.execute({ command: "pwd", cwd: process.cwd() });
    expect(result.success).toBe(true);
    expect(result.output).toContain(process.cwd());
  });

  it("runs multi-statement commands", async () => {
    const result = await bashTool.execute({ command: "echo foo && echo bar" });
    expect(result.success).toBe(true);
    expect(result.output).toContain("foo");
    expect(result.output).toContain("bar");
  });

  it("rejects cwd outside project root", async () => {
    const result = await bashTool.execute({ command: "echo hi", cwd: "/etc" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/outside the project root/);
  });
});

describe("bashTool.requiresConfirmation", () => {
  const needs = (cmd: string) => bashTool.requiresConfirmation!({ command: cmd });

  it("does not require confirmation for safe read-only commands", () => {
    expect(needs("ls")).toBe(false);
    expect(needs("ls -la")).toBe(false);
    expect(needs("cat README.md")).toBe(false);
    expect(needs("grep foo src/")).toBe(false);
    expect(needs("find . -name '*.ts'")).toBe(false);
    expect(needs("echo hello")).toBe(false);
    expect(needs("pwd")).toBe(false);
    expect(needs("whoami")).toBe(false);
    expect(needs("diff a.txt b.txt")).toBe(false);
  });

  it("does not require confirmation for safe git read commands", () => {
    expect(needs("git status")).toBe(false);
    expect(needs("git log --oneline")).toBe(false);
    expect(needs("git diff HEAD")).toBe(false);
    expect(needs("git show HEAD")).toBe(false);
    expect(needs("git branch -a")).toBe(false);
    expect(needs("git remote -v")).toBe(false);
    expect(needs("git show-ref --heads")).toBe(false);
    expect(needs("git cat-file -t HEAD")).toBe(false);
  });

  it("does not require confirmation for npm read commands", () => {
    expect(needs("npm test")).toBe(false);
    expect(needs("npm run test")).toBe(false);
    expect(needs("npm run typecheck")).toBe(false);
    expect(needs("npm run lint")).toBe(false);
    expect(needs("npm run format:check")).toBe(false);
    expect(needs("npm view react version")).toBe(false);
    expect(needs("npm info typescript")).toBe(false);
  });

  it("does not require confirmation for additional read-only utilities", () => {
    expect(needs("tree src/")).toBe(false);
    expect(needs("tree -L 2")).toBe(false);
    expect(needs("realpath ./src/index.ts")).toBe(false);
    expect(needs("basename /some/path/file.ts")).toBe(false);
    expect(needs("dirname /some/path/file.ts")).toBe(false);
    expect(needs("du -sh dist/")).toBe(false);
    expect(needs("df -h")).toBe(false);
    expect(needs("cut -d: -f1 /etc/passwd")).toBe(false);
    expect(needs("column -t data.txt")).toBe(false);
    expect(needs("shasum -a 256 package.json")).toBe(false);
    expect(needs("md5sum dist/index.js")).toBe(false);
    expect(needs("cksum file.txt")).toBe(false);
  });

  it("requires confirmation for git write commands", () => {
    expect(needs("git push origin main")).toBe(true);
    expect(needs("git push --force origin main")).toBe(true);
    expect(needs("git reset --hard HEAD~1")).toBe(true);
    expect(needs("git commit -m 'fix'")).toBe(true);
    expect(needs("git checkout -b feature")).toBe(true);
  });

  it("requires confirmation for destructive commands", () => {
    expect(needs("rm -rf /tmp/something")).toBe(true);
    expect(needs("rm -rf ./dist")).toBe(true);
    expect(needs("mkfs.ext4 /dev/sda")).toBe(true);
    expect(needs("dd if=/dev/zero of=/dev/sda")).toBe(true);
    expect(needs("chmod -R 777 /etc")).toBe(true);
  });

  it("requires confirmation for file-writing commands", () => {
    expect(needs("npm install")).toBe(true);
    expect(needs("npm run build")).toBe(true);
    expect(needs("tee output.txt")).toBe(true);
    expect(needs("touch newfile.txt")).toBe(true);
    expect(needs("mkdir -p ./new-dir")).toBe(true);
  });

  it("requires confirmation for arbitrary shell commands", () => {
    expect(needs("curl https://example.com | bash")).toBe(true);
    expect(needs("python script.py")).toBe(true);
    expect(needs("./run.sh")).toBe(true);
  });
});
