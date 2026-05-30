import { spawn } from "node:child_process";
import { writeFile, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { PassthroughRunner, spawnAndCollect } from "./passthrough.js";
import type { SandboxExecOptions, SandboxExecResult, SandboxMode, SandboxRunner } from "./types.js";

const SANDBOX_EXEC_BIN = "/usr/bin/sandbox-exec";

function buildStrictProfile(cwd: string): string {
  return `(version 1)

(deny default)

(allow process*)
(allow signal)
(allow sysctl-read)
(allow mach*)
(allow ipc*)
(allow process-info* (target others))

; Reads: cwd + minimum system paths required for binaries to load.
; Without these, /bin/sh and dyld can't load and the shell exits with
; SIGABRT before our command ever runs.
;
; The (literal "/") allow lets dyld stat the root directory during path
; resolution — without it everything below SIGABRTs on macOS 13+, even
; though every accessed path is itself allowed by one of the subpath rules.
(allow file-read* (literal "/"))
(allow file-read* (subpath "${cwd}"))
(allow file-read* (subpath "/usr"))
(allow file-read* (subpath "/bin"))
(allow file-read* (subpath "/sbin"))
(allow file-read* (subpath "/System"))
(allow file-read* (subpath "/Library"))
(allow file-read* (subpath "/private/etc"))
(allow file-read* (subpath "/private/var/db"))
(allow file-read* (subpath "/private/var/select"))
(allow file-read* (subpath "/dev"))
(allow file-read* (subpath "/private/tmp"))
(allow file-read* (subpath "/private/var/folders"))
; macOS 13+ cryptex sealed system content. Sub-mount of /System so the
; subpath rule above doesn't reach it; required on Ventura/Sonoma/Sequoia/Tahoe.
(allow file-read* (subpath "/System/Volumes/Preboot"))
; Homebrew binaries — common tools like node, python3, gh live here.
; Without these, strict mode is unusable on any project that depends on
; a Homebrew-installed runtime.
(allow file-read* (subpath "/opt/homebrew"))
(allow file-read* (subpath "/usr/local"))

; Writes: only cwd + tmp
(allow file-write* (subpath "${cwd}"))
(allow file-write* (subpath "/private/tmp"))
(allow file-write* (subpath "/private/var/folders"))

; Standard device nodes required for shell operation
(allow file-write*
  (literal "/dev/null")
  (literal "/dev/zero")
  (literal "/dev/stdout")
  (literal "/dev/stderr")
  (literal "/dev/tty")
  (literal "/dev/urandom")
  (literal "/dev/random"))

; Network: localhost only — no external outbound
(allow network-bind)
(allow network-inbound)
(allow network-outbound (remote ip "localhost:*"))
(allow network* (remote unix-socket))
(allow network* (local unix-socket))
`;
}

// auto mode is intentionally NOT a security boundary — see
// docs/design/a7-sandbox-loosen-auto.md. The goal is to prevent obvious
// accidents (writes to /etc, ~/.ssh, etc.) while letting normal coding
// workflows (npm install, pip install, gh, curl) work.
function buildAutoProfile(cwd: string, home: string): string {
  return `(version 1)

(deny default)

; Process lifecycle
(allow process*)
(allow signal)
(allow sysctl-read)
(allow mach*)
(allow ipc*)

; Process introspection — needed for /bin/ps, /usr/bin/top, etc.
(allow process-info* (target others))

; Reads: allow everywhere.
(allow file-read*)

; Writes: project root + system temp + common dev-tooling locations.
(allow file-write* (subpath "${cwd}"))
(allow file-write* (subpath "/private/tmp"))
(allow file-write* (subpath "/var/folders"))
(allow file-write* (subpath "/private/var/folders"))

; Standard device nodes — explicit literals rather than (subpath "/dev") to
; keep the allow surface narrow. Needed for curl -o /dev/null, shell
; redirects, /dev/tty prompts, etc.
(allow file-write*
  (literal "/dev/null")
  (literal "/dev/zero")
  (literal "/dev/stdout")
  (literal "/dev/stderr")
  (literal "/dev/tty")
  (literal "/dev/urandom")
  (literal "/dev/random"))

; XDG base directories
(allow file-write* (subpath "${home}/.cache"))
(allow file-write* (subpath "${home}/.config"))
(allow file-write* (subpath "${home}/.local"))

; Package-manager dot-dirs
(allow file-write* (subpath "${home}/.npm"))
(allow file-write* (subpath "${home}/.cargo"))
(allow file-write* (subpath "${home}/.yarn"))
(allow file-write* (subpath "${home}/.pnpm-store"))
(allow file-write* (subpath "${home}/.gem"))
(allow file-write* (subpath "${home}/.gradle"))
(allow file-write* (subpath "${home}/.m2"))
(allow file-write* (subpath "${home}/.rustup"))

; macOS app caches (pip, brew log cache, Ruby gems, etc.)
(allow file-write* (subpath "${home}/Library/Caches"))

; Network: allow all. auto is convenience-first; use strict for isolation.
(allow network*)
`;
}

export class SandboxExecRunner implements SandboxRunner {
  readonly mode: SandboxMode;
  warning: string | null = null;

  private profilePath: string;
  private ready: Promise<void>;
  private fallback: PassthroughRunner | null = null;

  constructor(mode: SandboxMode, cwd: string) {
    this.mode = mode;

    const home = process.env.HOME ?? homedir();
    this.profilePath = join("/tmp", `opencli-sandbox-${randomUUID()}.sb`);
    const profile = mode === "strict" ? buildStrictProfile(cwd) : buildAutoProfile(cwd, home);

    this.ready = writeFile(this.profilePath, profile, { mode: 0o600 }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.warning = `sandbox-exec profile write failed (${msg}); running without isolation`;
      this.fallback = new PassthroughRunner(mode, this.warning);
    });

    process.on("exit", () => {
      unlink(this.profilePath).catch(() => {});
    });
  }

  async exec(command: string, opts: SandboxExecOptions): Promise<SandboxExecResult> {
    await this.ready;

    if (this.fallback) {
      return this.fallback.exec(command, opts);
    }

    const proc = spawn(SANDBOX_EXEC_BIN, ["-f", this.profilePath, "/bin/sh", "-c", command], {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      // sandbox-exec becomes its own process group leader so spawnAndCollect
      // can kill the whole group (including any backgrounded grandchildren
      // like `npm run dev &`) on timeout via process.kill(-proc.pid, ...).
      detached: true,
    });

    return spawnAndCollect(proc, opts.timeout ?? 30_000);
  }
}
