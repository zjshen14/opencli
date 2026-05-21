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

  it("does not block external HTTPS via sandbox policy (npm install, gh, curl must work)", async () => {
    const result = await runner.exec("curl -s --max-time 5 https://example.com", {
      cwd: process.cwd(),
      timeout: 10_000,
    });
    // EPERM means the sandbox policy blocked the connection (the old, too-restrictive behaviour).
    // A network timeout or DNS failure is fine — those aren't a sandbox policy rejection.
    expect(result.stderr).not.toContain("EPERM");
  });

  it("allows writes to package-manager dot-dirs in HOME (~/.npm, ~/.cache, etc.)", async () => {
    const result = await runner.exec(
      "mkdir -p ~/.npm/.sandbox-test && rmdir ~/.npm/.sandbox-test",
      { cwd: process.cwd() },
    );
    expect(result.exitCode).toBe(0);
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
});
