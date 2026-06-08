/**
 * Sandbox contract eval — D2 sub-item.
 *
 * Sealed table of (profile × operation → allow|deny) expectations.
 * Each entry is a binding specification: if a refactor changes the
 * effective profile behaviour for an entry that was previously passing,
 * the test will fail and the diff forces a deliberate decision.
 *
 * Profiles covered:
 *   passthrough  — SandboxMode "off"  (PassthroughRunner; no isolation)
 *   bwrap auto   — SandboxMode "auto" on Linux (BwrapRunner; full host
 *                  read + CWD/tmp/dev-home write)
 *   bwrap strict — SandboxMode "strict" on Linux (BwrapRunner; CWD +
 *                  /tmp only, no network, no home)
 *
 * sandbox-exec (macOS) is intentionally omitted — the eval harness runs
 * on Linux CI; macOS-specific coverage lives in sandbox-exec.test.ts.
 */

import { describe, it, expect } from "vitest";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BwrapRunner } from "../../tools/exec/sandbox/bwrap.js";
import { PassthroughRunner } from "../../tools/exec/sandbox/passthrough.js";
import type { SandboxRunner } from "../../tools/exec/sandbox/types.js";

const isLinux = process.platform === "linux";
const CWD = process.cwd();
const HOME = process.env.HOME ?? homedir();
const TMP = tmpdir();

interface ContractCase {
  label: string;
  /** Factory so each test run gets a fresh path; avoids cross-test collisions. */
  command: () => string;
  allowed: boolean;
}

// ── sealed operation lists ────────────────────────────────────────────────────

const PASSTHROUGH_CASES: ContractCase[] = [
  {
    label: "write inside CWD",
    command: () => {
      const f = `${CWD}/.sandbox-contract-${Date.now()}`;
      return `touch "${f}" && rm "${f}"`;
    },
    allowed: true,
  },
  {
    label: "write to /tmp",
    command: () => {
      const f = `${TMP}/.sandbox-contract-${Date.now()}`;
      return `touch "${f}" && rm "${f}"`;
    },
    allowed: true,
  },
  {
    label: "read /etc/hosts",
    command: () => "cat /etc/hosts > /dev/null",
    allowed: true,
  },
];

const AUTO_CASES: ContractCase[] = [
  {
    label: "write inside CWD",
    command: () => {
      const f = `${CWD}/.sandbox-contract-${Date.now()}`;
      return `touch "${f}" && rm "${f}"`;
    },
    allowed: true,
  },
  {
    label: "write to /tmp",
    command: () => {
      const f = `${TMP}/.sandbox-contract-${Date.now()}`;
      return `touch "${f}" && rm "${f}"`;
    },
    allowed: true,
  },
  {
    label: "read /etc/hosts",
    command: () => "cat /etc/hosts > /dev/null",
    allowed: true,
  },
  {
    label: "write to ~/.npm",
    command: () => {
      const f = join(HOME, ".npm", `.sandbox-contract-${Date.now()}`);
      return `touch "${f}" && rm "${f}"`;
    },
    allowed: true,
  },
  {
    label: "write to ~/.cache",
    command: () => {
      const f = join(HOME, ".cache", `.sandbox-contract-${Date.now()}`);
      return `touch "${f}" && rm "${f}"`;
    },
    allowed: true,
  },
  {
    label: "external network (curl example.com)",
    command: () => "curl -s --max-time 5 -o /dev/null -w '%{http_code}' https://example.com",
    allowed: true,
  },
  // denied
  {
    label: "write to /etc (system dir, read-only bound)",
    command: () => `echo test >> /etc/.sandbox-contract-deny-${Date.now()}`,
    allowed: false,
  },
];

const STRICT_CASES: ContractCase[] = [
  {
    label: "write inside CWD",
    command: () => {
      const f = `${CWD}/.sandbox-contract-${Date.now()}`;
      return `touch "${f}" && rm "${f}"`;
    },
    allowed: true,
  },
  {
    label: "write to /tmp (tmpfs in strict mode)",
    command: () => {
      const f = `${TMP}/.sandbox-contract-${Date.now()}`;
      return `touch "${f}" && rm "${f}"`;
    },
    allowed: true,
  },
  {
    label: "read /etc/hosts",
    command: () => "cat /etc/hosts > /dev/null",
    allowed: true,
  },
  // denied
  {
    label: "external network (curl blocked by --unshare-net)",
    command: () => "curl -s --max-time 5 -o /dev/null https://example.com",
    allowed: false,
  },
  {
    label: "write to HOME (not mounted in strict mode)",
    command: () => `touch "${HOME}/.sandbox-contract-deny-${Date.now()}"`,
    allowed: false,
  },
  {
    label: "write to ~/.npm (not mounted in strict mode)",
    command: () => {
      const f = join(HOME, ".npm", `.sandbox-contract-deny-${Date.now()}`);
      return `touch "${f}"`;
    },
    allowed: false,
  },
  {
    label: "write to /etc (system dir, read-only bound)",
    command: () => `echo test >> /etc/.sandbox-contract-deny-${Date.now()}`,
    allowed: false,
  },
];

// ── helpers ───────────────────────────────────────────────────────────────────

async function runCase(runner: SandboxRunner, c: ContractCase): Promise<void> {
  const result = await runner.exec(c.command(), { cwd: CWD, timeout: 10_000 });
  if (c.allowed) {
    expect(result.exitCode, `"${c.label}" should be allowed (exit 0)`).toBe(0);
  } else {
    expect(result.exitCode, `"${c.label}" should be denied (non-zero exit)`).not.toBe(0);
  }
}

// ── contract suites ───────────────────────────────────────────────────────────

describe("sandbox contract — passthrough (off mode)", () => {
  const runner = new PassthroughRunner("off");

  for (const c of PASSTHROUGH_CASES) {
    it(`allow: ${c.label}`, async () => {
      await runCase(runner, c);
    });
  }
});

describe.skipIf(!isLinux)("sandbox contract — bwrap auto mode (Linux)", () => {
  const runner = new BwrapRunner("auto", CWD);

  for (const c of AUTO_CASES) {
    it(`${c.allowed ? "allow" : "deny"}: ${c.label}`, async () => {
      if (runner.warning) return; // bwrap unavailable on this host — skip
      await runCase(runner, c);
    });
  }
});

describe.skipIf(!isLinux)("sandbox contract — bwrap strict mode (Linux)", () => {
  const runner = new BwrapRunner("strict", CWD);

  for (const c of STRICT_CASES) {
    it(`${c.allowed ? "allow" : "deny"}: ${c.label}`, async () => {
      if (runner.warning) return;
      await runCase(runner, c);
    });
  }
});
