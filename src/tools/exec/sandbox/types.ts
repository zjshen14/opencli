export type SandboxMode = "auto" | "strict" | "off";

export interface SandboxExecOptions {
  /** Absolute path; always under process.cwd() — enforced by createBashTool(). */
  cwd: string;
  /** Milliseconds before SIGTERM is sent. Default: 30_000. */
  timeout?: number;
  /** Environment passed to the child. Default: process.env. */
  env?: NodeJS.ProcessEnv;
}

export interface SandboxExecResult {
  stdout: string;
  stderr: string;
  /** Exit code of the child process. -1 if killed by timeout or SIGTERM. */
  exitCode: number;
}

export interface SandboxRunner {
  /** Effective sandbox mode (may differ from requested mode on fallback). */
  readonly mode: SandboxMode;

  /**
   * Non-null when the requested mode could not be fully enforced.
   * The CLI emits this exactly once at startup via a stderr warning.
   * Null means full isolation is active.
   */
  readonly warning: string | null;

  exec(command: string, opts: SandboxExecOptions): Promise<SandboxExecResult>;
}
