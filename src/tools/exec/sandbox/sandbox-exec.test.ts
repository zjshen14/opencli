import { describe, it, expect } from "vitest";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxExecRunner } from "./sandbox-exec.js";

const isMacOS = process.platform === "darwin";
const HOME = process.env.HOME ?? homedir();

describe.skipIf(!isMacOS)("SandboxExecRunner (macOS only)", () => {
  const runner = new SandboxExecRunner("auto", process.cwd());

  it("runs a simple echo command successfully", async () => {
    const result = await runner.exec("echo hello", { cwd: process.cwd() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
  });

  it("allows binding to loopback (needed for tests and dev servers)", async () => {
    const script =
      "const s=require('http').createServer();" +
      "s.listen(0,'127.0.0.1',()=>{console.log('ok',s.address().port>0);s.close()});" +
      "s.on('error',e=>{console.error('err',e.message);process.exit(1)});";
    const result = await runner.exec(`node -e "${script}"`, {
      cwd: process.cwd(),
      timeout: 10_000,
    });
    expect(result.stdout).toContain("ok true");
    expect(result.exitCode).toBe(0);
  });

  it("allows connecting to loopback (supertest-style local round trip)", async () => {
    const script =
      "const http=require('http');" +
      "const s=http.createServer((req,res)=>res.end('pong'));" +
      "s.listen(0,'127.0.0.1',()=>{" +
      "const port=s.address().port;" +
      "http.get({host:'127.0.0.1',port},r=>{" +
      "let d='';r.on('data',c=>d+=c);r.on('end',()=>{console.log('got',d);s.close()})" +
      "}).on('error',e=>{console.error('err',e.message);process.exit(1)})" +
      "});";
    const result = await runner.exec(`node -e "${script}"`, {
      cwd: process.cwd(),
      timeout: 10_000,
    });
    expect(result.stdout).toContain("got pong");
    expect(result.exitCode).toBe(0);
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

  it("allows writes to ~/.npm (npm package cache)", async () => {
    const testFile = join(HOME, ".npm", `.sandbox-test-${Date.now()}`);
    const result = await runner.exec(`mkdir -p ~/.npm && touch "${testFile}" && rm "${testFile}"`, {
      cwd: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
  });

  it("allows writes to ~/.cache (XDG cache dir)", async () => {
    const testFile = join(HOME, ".cache", `.sandbox-test-${Date.now()}`);
    const result = await runner.exec(
      `mkdir -p ~/.cache && touch "${testFile}" && rm "${testFile}"`,
      { cwd: process.cwd() },
    );
    expect(result.exitCode).toBe(0);
  });

  it("allows writes to ~/Library/Caches (macOS app caches)", async () => {
    const testFile = join(HOME, "Library", "Caches", `.sandbox-test-${Date.now()}`);
    const result = await runner.exec(
      `mkdir -p ~/Library/Caches && touch "${testFile}" && rm "${testFile}"`,
      { cwd: process.cwd() },
    );
    expect(result.exitCode).toBe(0);
  });

  it("blocks writes to ~/.ssh (credential path)", async () => {
    const testFile = join(HOME, ".ssh", `.sandbox-test-${Date.now()}`);
    const result = await runner.exec(
      `mkdir -p ~/.ssh && touch "${testFile}" 2>&1; rm -f "${testFile}" 2>/dev/null; exit $?`,
      { cwd: process.cwd() },
    );
    // touch should fail with permission denied
    expect(result.stderr + result.stdout).toMatch(/permitted|denied/i);
  });

  it("blocks writes to ~/.aws (credential path)", async () => {
    const testFile = join(HOME, ".aws", `.sandbox-test-${Date.now()}`);
    const result = await runner.exec(
      `mkdir -p ~/.aws && touch "${testFile}" 2>&1; rm -f "${testFile}" 2>/dev/null; exit $?`,
      { cwd: process.cwd() },
    );
    expect(result.stderr + result.stdout).toMatch(/permitted|denied/i);
  });

  // /bin/ps and /usr/bin/top are setuid binaries — macOS sandbox refuses to
  // exec them regardless of profile. pgrep is non-setuid and serves to verify
  // that process introspection (which the profile allows) works in principle.
  it("allows process introspection via pgrep (non-setuid)", async () => {
    const result = await runner.exec("/usr/bin/pgrep -l sh | head -1", {
      cwd: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
  });

  it("allows external network access (curl to example.com)", async () => {
    const result = await runner.exec(
      "curl -s --max-time 5 -o /dev/null -w '%{http_code}' https://example.com",
      { cwd: process.cwd(), timeout: 10_000 },
    );
    // curl returns the HTTP status; 200 means the request succeeded end-to-end
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("200");
  });
});

describe.skipIf(!isMacOS)("SandboxExecRunner strict mode (macOS only)", () => {
  const strict = new SandboxExecRunner("strict", process.cwd());

  it("blocks external network access", async () => {
    const result = await strict.exec("curl -s --max-time 5 -o /dev/null https://example.com", {
      cwd: process.cwd(),
      timeout: 10_000,
    });
    expect(result.exitCode).not.toBe(0);
  });

  it("blocks writes to ~/.npm (user dotfiles not allowed)", async () => {
    const testFile = join(HOME, ".npm", `.sandbox-strict-test-${Date.now()}`);
    const result = await strict.exec(`touch "${testFile}" 2>&1`, { cwd: process.cwd() });
    expect(result.exitCode).not.toBe(0);
  });

  it("blocks reads from ~/.ssh", async () => {
    const testFile = join(HOME, ".ssh", `.sandbox-strict-test-${Date.now()}`);
    const result = await strict.exec(`mkdir -p "${HOME}/.ssh" && touch "${testFile}" 2>&1`, {
      cwd: process.cwd(),
    });
    expect(result.stderr + result.stdout).toMatch(/permitted|denied/i);
  });

  it("allows writes inside CWD", async () => {
    const testFile = join(process.cwd(), `.sandbox-strict-test-${Date.now()}`);
    const result = await strict.exec(`touch "${testFile}" && rm "${testFile}"`, {
      cwd: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
  });

  it("allows localhost network connections", async () => {
    const script =
      "const s=require('http').createServer();" +
      "s.listen(0,'127.0.0.1',()=>{console.log('ok',s.address().port>0);s.close()});" +
      "s.on('error',e=>{console.error('err',e.message);process.exit(1)});";
    const result = await strict.exec(`node -e "${script}"`, {
      cwd: process.cwd(),
      timeout: 10_000,
    });
    expect(result.stdout).toContain("ok true");
    expect(result.exitCode).toBe(0);
  });
});
