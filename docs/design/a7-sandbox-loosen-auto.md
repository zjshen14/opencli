# Design: A7 — Loosen `auto` sandbox, implement real `strict`

_Status: Phase 1 Implemented — merged in PR [#148](https://github.com/zjshen14/opencli/pull/148) (2026-05-23). Phase 2 Implemented — merged via [#149](https://github.com/zjshen14/opencli/issues/149) (2026-05-24)._

---

## Problem

The current `auto` sandbox profile (shipped in [A1](a1-sandbox.md)) blocks at least three operations every real coding workflow requires:

1. **Writes to package-manager dot-dirs in `$HOME`** — `~/.npm/_logs/`, `~/.cache/pip/`, `~/.cargo/registry/`, `~/.local/`, `~/.yarn/`, `~/.gem/`. The profile only allows writes to `${cwd}`, `/tmp`, `/var/folders`. Every `npm install`, `pip install`, `cargo build`, etc. fails on first cache write.
2. **External network access** — only `localhost` is allowed outbound. `npm install`, `pip install`, `gh pr create`, `git clone <external>`, `curl https://api.github.com/...` all fail.
3. **Process introspection** — `(allow process*)` covers process *operations* but not `process-info-pidinfo`. Adding `(allow process-info* (target others))` enables non-setuid tools (`pgrep`, custom inspectors). **Note:** `/bin/ps` and `/usr/bin/top` are setuid root on macOS — macOS sandbox-exec refuses to exec setuid binaries regardless of profile. This is a platform-level limitation, not a profile bug. Workaround: use `pgrep`, `lsof -p`, or `/proc`-equivalent calls in scripts.

Real-world repro from issue #127: a `create-next-app` scaffold session hit all three blocks in sequence. The agent's recommended remediation is always "restart with `--sandbox off`" — meaning the default mode is unusable.

### Why the current `auto` is theatre

The intent of A1's `auto` was "block data exfiltration." But:

- `(allow file-read*)` is unrestricted — `~/.ssh/id_rsa`, `~/.aws/credentials`, GitHub tokens, shell history, browser data are all readable.
- `(allow file-write* (subpath "${cwd}"))` lets the agent stage exfil files: write secrets into `${cwd}/leaked.txt` and ask the user to read, paste, or commit them.
- The only thing the network deny actually prevents is *one-step autonomous* exfiltration over HTTPS.

So `auto` buys "agent can't curl your secrets out without user help" in exchange for "every real coding workflow breaks." That trade is wrong.

## Goal

Reframe the mode taxonomy:

| Mode | Purpose | Trust model |
|---|---|---|
| `off` | No isolation | Trusted local environment |
| `auto` (default) | **Prevent obvious accidents.** Writes restricted to dev-tooling locations. Reads/network unrestricted. | Convenience first. Not a security boundary. |
| `strict` | **Real isolation.** No outbound network. Writes only to `${cwd}` + tmp. Reads restricted to `${cwd}` + system binary paths. | Untrusted code; expect friction. |

This matches industry defaults (Cursor, Cline, Claude Code) and is honest about what each mode buys.

---

## Scope

| Item | Status |
|---|---|
| Loosen `auto` (writes, network, ps) — macOS + Linux | Phase 1 |
| Update docs/tests for new `auto` semantics | Phase 1 |
| Implement real `strict` mode — macOS + Linux | Phase 2 |
| Remove "strict mode not yet implemented" warning | Phase 2 (after strict ships) |
| Allow-listing custom paths via config | Out of scope — defer until user demand |
| Container-mode sandbox | Out of scope — covered by roadmap C4 |

Phase 1 ships the urgent unblock. Phase 2 adds real strict mode as a separate PR — separate review surface, lower urgency.

---

## Phase 1 — Loosen `auto`

### macOS — new `buildAutoProfile`

File: [src/tools/exec/sandbox/sandbox-exec.ts](../../src/tools/exec/sandbox/sandbox-exec.ts)

```scheme
(version 1)
(deny default)

; Process lifecycle
(allow process*)
(allow signal)
(allow sysctl-read)
(allow mach*)
(allow ipc*)

; NEW: process introspection (enables non-setuid tools like pgrep)
(allow process-info* (target others))

; Reads: allow everywhere (unchanged)
(allow file-read*)

; Writes: project root + system temp (unchanged)
(allow file-write* (subpath "${cwd}"))
(allow file-write* (subpath "/private/tmp"))
(allow file-write* (subpath "/private/var/folders"))

; NEW: standard device nodes (explicit literals to keep allow surface narrow)
; Required for curl -o /dev/null, shell redirects, /dev/tty prompts.
(allow file-write*
  (literal "/dev/null")
  (literal "/dev/zero")
  (literal "/dev/stdout")
  (literal "/dev/stderr")
  (literal "/dev/tty")
  (literal "/dev/urandom")
  (literal "/dev/random"))

; NEW: XDG base directories
(allow file-write* (subpath "${HOME}/.cache"))
(allow file-write* (subpath "${HOME}/.config"))
(allow file-write* (subpath "${HOME}/.local"))

; NEW: package-manager dot-dirs
(allow file-write* (subpath "${HOME}/.npm"))
(allow file-write* (subpath "${HOME}/.cargo"))
(allow file-write* (subpath "${HOME}/.yarn"))
(allow file-write* (subpath "${HOME}/.pnpm-store"))
(allow file-write* (subpath "${HOME}/.gem"))
(allow file-write* (subpath "${HOME}/.gradle"))
(allow file-write* (subpath "${HOME}/.m2"))
(allow file-write* (subpath "${HOME}/.rustup"))

; NEW: macOS app caches (pip, brew log cache, etc.)
(allow file-write* (subpath "${HOME}/Library/Caches"))

; CHANGED: network — allow all outbound (was: deny outbound except localhost)
(allow network*)
```

**Interpolation.** `${HOME}` is read at runner construction from `process.env.HOME ?? os.homedir()`, same pattern as `${cwd}`. The runner is scoped to startup — `HOME` and `cwd` are fixed for the session.

**Still blocked** (deny-default catches):
- Credential paths: `~/.ssh/`, `~/.aws/`, `~/.gnupg/`, `~/.docker/`, `~/.kube/`, `~/.terraform.d/`
- User data: `~/Documents/`, `~/Desktop/`, `~/Pictures/`, `~/Movies/`, `~/Music/`
- System: `/etc/`, `/usr/`, `/System/`, `/Library/Application Support/`, `/Applications/`

The list of allowed dot-dirs is intentionally conservative — it covers the universal package managers without opening sensitive locations.

### Linux — new `buildAutoArgs`

File: [src/tools/exec/sandbox/bwrap.ts](../../src/tools/exec/sandbox/bwrap.ts)

```typescript
function buildAutoArgs(cwd: string, home: string): string[] {
  const args = [
    "--ro-bind", "/", "/",
    "--bind", cwd, cwd,
    "--tmpfs", "/tmp",
    "--dev", "/dev",
    "--proc", "/proc",
    // CHANGED: no --unshare-net — external network works
  ];

  // NEW: bind common dev dot-dirs writable
  for (const sub of AUTO_HOME_DIRS) {
    const path = join(home, sub);
    if (existsSync(path)) {
      args.push("--bind", path, path);
    }
  }

  return args;
}

const AUTO_HOME_DIRS = [
  ".cache", ".config", ".local",
  ".npm", ".cargo", ".yarn", ".pnpm-store",
  ".gem", ".gradle", ".m2", ".rustup",
];
```

**Pre-create at runner construction.** bwrap's `--bind` fails if the source path doesn't exist. To avoid first-run breakage, pre-create the AUTO_HOME_DIRS set at `BwrapRunner` construction:

```typescript
async function ensureAutoHomeDirs(home: string): Promise<void> {
  await Promise.all(
    AUTO_HOME_DIRS.map((sub) => mkdir(join(home, sub), { recursive: true }).catch(() => {})),
  );
}
```

Errors are swallowed — if `~/.cache` already exists or can't be created, the bind is best-effort.

`/bin/ps` already works on Linux today because `/proc` is bind-mounted; no extra changes needed.

### CLI / config / mode resolution

No changes to `SandboxMode` enum or resolution logic. `auto` keeps its name, just behaves differently. Mode resolution (`--sandbox` flag → `OPENCLI_SANDBOX` env → config → "auto") is unchanged.

### Docs

- [README.md](../../README.md) sandbox section: update mode comparison table.
  - **Old:** `auto (default) | Network denied; writes allowed only inside CWD and /tmp`
  - **New:** `auto (default) | Prevent accidental writes to system & credential paths. Network unrestricted. Suitable for trusted development.`
- [docs/architecture.md](../architecture.md) sandbox layer section: same update.
- **Add a clear callout** explaining that `auto` is NOT a security boundary; `strict` (Phase 2) is the real isolation mode.

---

## Phase 2 — Real `strict` mode

Separate PR after Phase 1 lands. Lower urgency.

### macOS — `buildStrictProfile`

```scheme
(version 1)
(deny default)

(allow process*)
(allow signal)
(allow sysctl-read)
(allow mach*)
(allow ipc*)
(allow process-info* (target others))

; Reads: cwd + minimum system paths required for binaries to load
(allow file-read* (subpath "${cwd}"))
(allow file-read* (subpath "/usr"))
(allow file-read* (subpath "/bin"))
(allow file-read* (subpath "/sbin"))
(allow file-read* (subpath "/System"))
(allow file-read* (subpath "/Library"))
(allow file-read* (subpath "/private/etc"))      ; resolv.conf, passwd
(allow file-read* (subpath "/private/var/db"))   ; dyld cache
(allow file-read* (subpath "/dev"))
(allow file-read* (subpath "/private/tmp"))
(allow file-read* (subpath "/private/var/folders"))

; Writes: only cwd + tmp
(allow file-write* (subpath "${cwd}"))
(allow file-write* (subpath "/private/tmp"))
(allow file-write* (subpath "/private/var/folders"))

; Network: localhost only (intentional friction)
(allow network-bind)
(allow network-inbound)
(allow network-outbound (remote ip "localhost:*"))
(allow network* (remote unix-socket))
(allow network* (local unix-socket))
```

This blocks reads of `~/.ssh/`, `~/.aws/`, etc. without falling back to allow-everywhere — the actual isolation promise users want.

### Linux — `buildStrictArgs`

```typescript
function buildStrictArgs(cwd: string): string[] {
  return [
    "--unshare-net",
    "--ro-bind", "/usr", "/usr",
    "--ro-bind", "/bin", "/bin",
    "--ro-bind", "/sbin", "/sbin",
    "--ro-bind", "/lib", "/lib",
    "--ro-bind", "/lib64", "/lib64",
    "--ro-bind", "/etc", "/etc",
    "--bind", cwd, cwd,
    "--tmpfs", "/tmp",
    "--dev", "/dev",
    "--proc", "/proc",
    // NO --ro-bind / /  ← this is the isolation guarantee
    // NO HOME bindings  ← no access to user dotfiles
  ];
}
```

This drops the blanket `--ro-bind / /` and instead enumerates the minimum system paths. The user's `$HOME` is *not* mounted into the sandbox namespace at all — strict reads are limited to `${cwd}` and system binaries.

### Phase 2 wiring

Remove the strict-to-auto fallback in both `SandboxExecRunner` and `BwrapRunner` constructors. Drop the `"[opencli] warn: strict mode not yet implemented"` stderr write.

---

## Failure modes

| Scenario | Phase 1 behavior |
|---|---|
| `npm install <pkg>` from fresh project | ✅ succeeds (writes to `~/.npm`, network to registry.npmjs.org) |
| `pip install <pkg>` | ✅ succeeds (writes to `~/Library/Caches/pip` on macOS, `~/.cache/pip` on Linux) |
| `cargo build` | ✅ succeeds (writes to `~/.cargo`) |
| `gh pr create` | ✅ succeeds (HTTPS to api.github.com) |
| `git clone <external>` | ✅ succeeds |
| `npx create-next-app foo` | ✅ succeeds |
| `/bin/ps`, `/usr/bin/top` | ✅ succeeds (process-info allow on macOS; already worked on Linux) |
| `rm -rf /etc/hosts` | ❌ still denied |
| Agent writes to `~/.ssh/authorized_keys` | ❌ still denied |
| Agent writes to `~/Documents/foo.txt` | ❌ still denied |
| `curl https://attacker.com/...` | ⚠️ now allowed in auto (was denied). Use strict (Phase 2) to deny. |

| Scenario | Phase 2 strict behavior |
|---|---|
| `npm install` | ❌ denied (no network, no `~/.npm` write) |
| `curl https://example.com` | ❌ denied |
| Read `~/.ssh/id_rsa` | ❌ denied |
| Write to `${cwd}/output.txt` | ✅ succeeds |
| Local test server on 127.0.0.1 | ✅ succeeds |

---

## Test strategy

### Phase 1 — update existing tests

File: [src/tools/exec/sandbox/sandbox-exec.test.ts](../../src/tools/exec/sandbox/sandbox-exec.test.ts)

| Test | Change |
|---|---|
| `"blocks external network access (curl to example.com)"` | **Delete** — `auto` now allows external network. Add to strict-mode describe in Phase 2. |
| `"allows binding to loopback"` | Keep — still works. |
| `"allows connecting to loopback"` | Keep. |
| `"allows writes inside CWD"` | Keep. |
| `"blocks writes to /etc/hosts"` | Keep — still denied (`/etc` not in allow list). |
| `"allows writes to /tmp"` | Keep. |

File: [src/tools/exec/sandbox/bwrap.test.ts](../../src/tools/exec/sandbox/bwrap.test.ts) — same pattern: delete the network-deny test, keep cwd/tmp/etc-hosts.

### Phase 1 — new tests

```typescript
// macOS
it("allows writes to ~/.npm (npm package cache)", async () => {
  const home = process.env.HOME!;
  const testFile = join(home, `.npm/.sandbox-test-${Date.now()}`);
  const result = await runner.exec(
    `mkdir -p ~/.npm && touch "${testFile}" && rm "${testFile}"`,
    { cwd: process.cwd() },
  );
  expect(result.exitCode).toBe(0);
});

it("allows writes to ~/.cache (XDG cache dir)", async () => { /* analogous */ });
it("allows writes to ~/Library/Caches (macOS app caches)", async () => { /* analogous */ });

it("blocks writes to ~/.ssh (credential path)", async () => {
  const result = await runner.exec(
    `touch "${process.env.HOME}/.ssh/.sandbox-test-${Date.now()}"`,
    { cwd: process.cwd() },
  );
  expect(result.exitCode).not.toBe(0);
});

it("blocks writes to ~/.aws (credential path)", async () => { /* analogous */ });

it("allows external network access (curl to example.com)", async () => {
  const result = await runner.exec("curl -s --max-time 5 -o /dev/null https://example.com", {
    cwd: process.cwd(),
    timeout: 10_000,
  });
  expect(result.exitCode).toBe(0);
});

it("allows /bin/ps (process introspection)", async () => {
  const result = await runner.exec("ps -p $$", { cwd: process.cwd() });
  expect(result.exitCode).toBe(0);
});
```

Linux equivalents in `bwrap.test.ts`. Use the same `if (runner.warning) return;` guard pattern that's already in place.

### Phase 2 — strict mode tests

```typescript
describe.skipIf(!isMacOS)("SandboxExecRunner strict mode", () => {
  const runner = new SandboxExecRunner("strict", process.cwd());

  it("blocks external network", async () => {
    const result = await runner.exec("curl -s --max-time 5 https://example.com", {
      cwd: process.cwd(), timeout: 10_000,
    });
    expect(result.exitCode).not.toBe(0);
  });

  it("blocks writes to ~/.npm", async () => { /* fails */ });
  it("blocks reads from ~/.ssh", async () => { /* fails */ });
  it("allows writes to cwd", async () => { /* succeeds */ });
  it("allows localhost connections", async () => { /* succeeds */ });
});
```

---

## Decisions to confirm before implementation

| Decision | Recommended |
|---|---|
| Auto network: all outbound vs. restricted ports | **All outbound.** Restricted ports break Redis/Postgres/MySQL/SMTP/dev servers for tiny security gain. |
| Linux: pre-create dot-dirs vs. document requirement | **Pre-create at construction.** Invisible to user; one-time `mkdir -p` of empty dirs. |
| Phase 1 & 2 together or separate PRs | **Separate.** Phase 1 unblocks users in days. Phase 2 needs its own review (real isolation has different test concerns). |
| Allow `${HOME}/.docker/`, `~/.kube/`, `~/.terraform.d/` in auto | **No.** These contain auth credentials; rarely needed for coding tasks. Users who need them can use `--sandbox off`. |
| Configurable extra-allow list in `~/.opencli/config.json` | **Defer.** Add when a user actually needs it. The hardcoded list covers >95% of cases. |

---

## File change summary

### Phase 1

| Action | File |
|---|---|
| Modify | [src/tools/exec/sandbox/sandbox-exec.ts](../../src/tools/exec/sandbox/sandbox-exec.ts) — expand `buildAutoProfile`, interpolate `${HOME}`, add `process-info*` allow, allow all network |
| Modify | [src/tools/exec/sandbox/bwrap.ts](../../src/tools/exec/sandbox/bwrap.ts) — drop `--unshare-net`, add `AUTO_HOME_DIRS` binds, pre-create at construction |
| Modify | [src/tools/exec/sandbox/sandbox-exec.test.ts](../../src/tools/exec/sandbox/sandbox-exec.test.ts) — delete network-deny test, add dot-dir tests, add `ps` test, add network-allow test |
| Modify | [src/tools/exec/sandbox/bwrap.test.ts](../../src/tools/exec/sandbox/bwrap.test.ts) — same pattern as sandbox-exec.test.ts |
| Modify | [README.md](../../README.md) — sandbox mode table description |
| Modify | [docs/architecture.md](../architecture.md) — sandbox layer section, mode table |

No changes to `core/`, `providers/`, `cli/`, `state/`, or `tools/` outside the sandbox subtree.

### Phase 2

| Action | File |
|---|---|
| Modify | `src/tools/exec/sandbox/sandbox-exec.ts` — add `buildStrictProfile`, remove strict→auto fallback |
| Modify | `src/tools/exec/sandbox/bwrap.ts` — add `buildStrictArgs`, remove strict→auto fallback, drop stderr warning |
| Modify | `src/tools/exec/sandbox/sandbox-exec.test.ts` — add strict describe block |
| Modify | `src/tools/exec/sandbox/bwrap.test.ts` — add strict describe block |
| Modify | `README.md` — document `strict` as production-ready |
| Modify | `docs/architecture.md` — update mode comparison |

---

## References

- [Issue #127](https://github.com/zjshen14/opencli/issues/127) — original report with concrete repros
- [A1 design doc](a1-sandbox.md) — original sandbox design; Q2 explicitly deferred real `strict`
- [Apple Sandbox Guide v1.0 (community-maintained, reverse-engineered — not an official Apple document)](https://reverse.put.as/wp-content/uploads/2011/09/Apple-Sandbox-Guide-v1.0.pdf) — most complete public reference for the `sandbox-exec` profile language (`process-info*`, `file-write*`, `network*` operations). Apple's official `sandbox-exec(1)` man page exists but is sparse.
- [bubblewrap docs](https://github.com/containers/bubblewrap) — `--bind`, `--ro-bind`, `--unshare-net`, namespace requirements
- Industry comparison: [Cursor](https://docs.cursor.com/), [Cline](https://github.com/cline/cline), [Claude Code](https://docs.claude.com/en/docs/claude-code) all default to "loose with opt-in isolation" rather than "deny-default."
