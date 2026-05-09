import { spawn } from "node:child_process";
import type { SandboxExecOptions, SandboxExecResult, SandboxMode, SandboxRunner } from "./types.js";

/**
 * Collect stdout/stderr from a spawned process and resolve when it closes.
 * Sends SIGTERM after timeoutMs and resolves with exitCode -1.
 */
export async function spawnAndCollect(
  proc: ReturnType<typeof spawn>,
  timeoutMs: number,
): Promise<SandboxExecResult> {
  return new Promise((resolve) => {
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    proc.stdout?.on("data", (chunk: Buffer) => stdout.push(chunk));
    proc.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8").trimEnd(),
        stderr: Buffer.concat(stderr).toString("utf8").trimEnd(),
        exitCode: timedOut ? -1 : (code ?? 1),
      });
    });
  });
}

export class PassthroughRunner implements SandboxRunner {
  readonly mode: SandboxMode;
  readonly warning: string | null;

  constructor(mode: SandboxMode, warning: string | null = null) {
    this.mode = mode;
    this.warning = warning;
  }

  async exec(command: string, opts: SandboxExecOptions): Promise<SandboxExecResult> {
    const proc = spawn("bash", ["-c", command], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return spawnAndCollect(proc, opts.timeout ?? 30_000);
  }
}
