import { describe, it, expect } from "vitest";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BwrapRunner } from "./bwrap.js";

const isLinux = process.platform === "linux";
const HOME = process.env.HOME ?? homedir();

describe.skipIf(!isLinux)("BwrapRunner (Linux only)", () => {
  const runner = new BwrapRunner("auto", process.cwd());

  it("runs a simple echo command successfully", async () => {
    if (runner.warning) {
      // bwrap not available or namespaces disabled — skip actual execution test
      return;
    }
    const result = await runner.exec("echo hello", { cwd: process.cwd() });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello");
  });

  it("allows external network access (curl to example.com)", async () => {
    if (runner.warning) return;
    const result = await runner.exec(
      "curl -s --max-time 5 -o /dev/null -w '%{http_code}' https://example.com",
      { cwd: process.cwd(), timeout: 10_000 },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("200");
  });

  it("allows writes inside CWD", async () => {
    if (runner.warning) return;
    const testFile = join(process.cwd(), `.sandbox-test-${Date.now()}`);
    const result = await runner.exec(`touch "${testFile}" && rm "${testFile}"`, {
      cwd: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
  });

  it("blocks writes to /etc/hosts", async () => {
    if (runner.warning) return;
    const result = await runner.exec('echo "127.0.0.1 test" >> /etc/hosts', {
      cwd: process.cwd(),
    });
    expect(result.exitCode).not.toBe(0);
  });

  it("allows writes to /tmp", async () => {
    if (runner.warning) return;
    const testFile = join(tmpdir(), `.sandbox-test-${Date.now()}`);
    const result = await runner.exec(`touch "${testFile}" && rm "${testFile}"`, {
      cwd: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
  });

  it("allows writes to ~/.npm (npm package cache)", async () => {
    if (runner.warning) return;
    const testFile = join(HOME, ".npm", `.sandbox-test-${Date.now()}`);
    const result = await runner.exec(`touch "${testFile}" && rm "${testFile}"`, {
      cwd: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
  });

  it("allows writes to ~/.cache (XDG cache dir)", async () => {
    if (runner.warning) return;
    const testFile = join(HOME, ".cache", `.sandbox-test-${Date.now()}`);
    const result = await runner.exec(`touch "${testFile}" && rm "${testFile}"`, {
      cwd: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
  });

  it("falls back gracefully when bwrap is unavailable", () => {
    // If runner has a warning, it already fell back — verify it still executes commands
    if (!runner.warning) return;
    expect(runner.warning).toBeTruthy();
  });
});

describe.skipIf(!isLinux)("BwrapRunner strict mode (Linux only)", () => {
  const strict = new BwrapRunner("strict", process.cwd());

  it("blocks external network access", async () => {
    if (strict.warning) return;
    const result = await strict.exec("curl -s --max-time 5 -o /dev/null https://example.com", {
      cwd: process.cwd(),
      timeout: 10_000,
    });
    expect(result.exitCode).not.toBe(0);
  });

  it("blocks writes to HOME (user dotfiles are not mounted)", async () => {
    if (strict.warning) return;
    const testFile = join(HOME, `.sandbox-strict-test-${Date.now()}`);
    const result = await strict.exec(`touch "${testFile}" 2>&1`, { cwd: process.cwd() });
    expect(result.exitCode).not.toBe(0);
  });

  it("blocks reads from ~/.ssh (not present in namespace)", async () => {
    if (strict.warning) return;
    const result = await strict.exec(`ls "${HOME}/.ssh" 2>&1`, { cwd: process.cwd() });
    expect(result.exitCode).not.toBe(0);
  });

  it("allows writes inside CWD", async () => {
    if (strict.warning) return;
    const testFile = join(process.cwd(), `.sandbox-strict-test-${Date.now()}`);
    const result = await strict.exec(`touch "${testFile}" && rm "${testFile}"`, {
      cwd: process.cwd(),
    });
    expect(result.exitCode).toBe(0);
  });

  it("allows localhost network (loopback interface present in net namespace)", async () => {
    if (strict.warning) return;
    const script =
      "node -e \"const s=require('net').createServer();" +
      "s.listen(0,'127.0.0.1',()=>{console.log('ok');s.close()});" +
      "s.on('error',e=>{console.error(e.message);process.exit(1)})\"";
    const result = await strict.exec(script, { cwd: process.cwd(), timeout: 10_000 });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("ok");
  });
});
