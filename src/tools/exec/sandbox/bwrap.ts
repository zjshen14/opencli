import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PassthroughRunner, spawnAndCollect } from "./passthrough.js";
import type { SandboxExecOptions, SandboxExecResult, SandboxMode, SandboxRunner } from "./types.js";

const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/usr/local/bin/bwrap"];

// Common dev-tooling dot-dirs bound writable in auto mode. Pre-created at
// runner construction so bwrap's --bind doesn't fail when a path is absent.
// See docs/design/a7-sandbox-loosen-auto.md.
const AUTO_HOME_DIRS = [
  ".cache",
  ".config",
  ".local",
  ".npm",
  ".cargo",
  ".yarn",
  ".pnpm-store",
  ".gem",
  ".gradle",
  ".m2",
  ".rustup",
];

// Minimum system paths exposed read-only in strict mode. Only paths that
// exist on this host are bound — avoids bwrap failure on paths absent in
// some distros (e.g. /lib64 on Alpine, /sbin on Debian merged-usr systems).
const STRICT_SYSTEM_PATHS = ["/usr", "/bin", "/sbin", "/lib", "/lib64", "/etc"];

function buildStrictArgs(cwd: string): string[] {
  const args: string[] = ["--unshare-net"];
  for (const p of STRICT_SYSTEM_PATHS) {
    if (existsSync(p)) {
      args.push("--ro-bind", p, p);
    }
  }
  args.push("--bind", cwd, cwd, "--tmpfs", "/tmp", "--dev", "/dev", "--proc", "/proc");
  return args;
}

function detectBwrap(): string | null {
  for (const candidate of BWRAP_CANDIDATES) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "pipe", timeout: 2000 });
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
}

function probeNamespaces(bwrapBin: string): boolean {
  try {
    // Mount /usr too: on Ubuntu 20.04+ /bin is a symlink to /usr/bin, so /bin/true
    // needs /usr to be accessible inside the namespace to avoid a false negative.
    execFileSync(
      bwrapBin,
      ["--unshare-net", "--ro-bind", "/usr", "/usr", "--ro-bind", "/bin", "/bin", "/bin/true"],
      { stdio: "pipe", timeout: 5000 },
    );
    return true;
  } catch {
    return false;
  }
}

export class BwrapRunner implements SandboxRunner {
  readonly mode: SandboxMode;
  readonly warning: string | null;

  private bwrapBin: string;
  private cwd: string;
  private autoBinds: string[] = [];
  private fallback: PassthroughRunner | null = null;

  constructor(mode: SandboxMode, cwd: string) {
    this.mode = mode;
    this.cwd = cwd;

    const bin = detectBwrap();
    if (!bin) {
      this.bwrapBin = "";
      this.warning = "bwrap not found; running without sandbox isolation";
      this.fallback = new PassthroughRunner(this.mode, this.warning);
      return;
    }

    if (!probeNamespaces(bin)) {
      this.bwrapBin = "";
      this.warning =
        "bwrap user namespaces are disabled on this system; running without sandbox isolation";
      this.fallback = new PassthroughRunner(this.mode, this.warning);
      return;
    }

    this.bwrapBin = bin;
    this.warning = null;

    if (mode !== "strict") {
      const home = process.env.HOME ?? homedir();
      for (const sub of AUTO_HOME_DIRS) {
        const path = join(home, sub);
        try {
          mkdirSync(path, { recursive: true });
          this.autoBinds.push("--bind", path, path);
        } catch {
          // best-effort: skip dirs we can't create (read-only home, etc.)
        }
      }
    }
  }

  async exec(command: string, opts: SandboxExecOptions): Promise<SandboxExecResult> {
    if (this.fallback) {
      return this.fallback.exec(command, opts);
    }

    const bwrapArgs =
      this.mode === "strict"
        ? buildStrictArgs(this.cwd)
        : [
            "--ro-bind",
            "/",
            "/",
            "--bind",
            this.cwd,
            this.cwd,
            "--tmpfs",
            "/tmp",
            "--dev",
            "/dev",
            "--proc",
            "/proc",
            ...this.autoBinds,
          ];

    const proc = spawn(this.bwrapBin, [...bwrapArgs, "--", "/bin/sh", "-c", command], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      // bwrap becomes its own process group leader so spawnAndCollect
      // can kill the whole group (including backgrounded grandchildren)
      // on timeout via process.kill(-proc.pid, ...).
      detached: true,
    });

    return spawnAndCollect(proc, opts.timeout ?? 30_000);
  }
}
