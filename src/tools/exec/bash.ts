import { spawn } from "node:child_process";
import type { Tool } from "../base.js";

const TIMEOUT_MS = 30_000;

// Commands matching these patterns are considered safe read-only operations that
// do not require user confirmation before running.
const SAFE_COMMANDS = [
  // File inspection
  /^ls(\s|$)/,
  /^cat(\s|$)/,
  /^head(\s|$)/,
  /^tail(\s|$)/,
  /^grep(\s|$)/,
  /^rg(\s|$)/,
  /^find(\s|$)/,
  /^diff(\s|$)/,
  /^stat(\s|$)/,
  /^wc(\s|$)/,
  /^sort(\s|$)/,
  /^uniq(\s|$)/,
  /^file(\s|$)/,
  /^type(\s|$)/,
  // Shell utilities
  /^echo(\s|$)/,
  /^printf(\s|$)/,
  /^pwd$/,
  /^which(\s|$)/,
  /^whoami$/,
  /^date(\s|$)/,
  /^env(\s|$)/,
  /^printenv(\s|$)/,
  // Git read-only operations
  /^git\s+(status|log|diff|show|branch|remote|tag|describe|rev-parse|shortlog|blame|ls-files|ls-tree|stash\s+list)(\s|$)/,
  // npm / node read-only
  /^npm\s+(test|run\s+(test|typecheck|lint|format:check)|ls|list|audit|outdated)(\s|$)/,
  /^npx\s+tsc(\s|$)/,
  /^node\s+(--version|-v)$/,
  /^npm\s+(--version|-v)$/,
];

export const bashTool: Tool = {
  name: "bash",
  description:
    "Execute a shell command and return its output. Avoid destructive operations. Commands timeout after 30 seconds.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string", description: "The shell command to execute" },
      cwd: {
        type: "string",
        description: "Working directory for the command (defaults to process cwd)",
      },
    },
    required: ["command"],
  },
  requiresConfirmation(args): boolean {
    const cmd = (args.command as string).trim();
    return !SAFE_COMMANDS.some((p) => p.test(cmd));
  },
  async execute({ command, cwd }) {
    const cmd = command as string;

    return new Promise((resolve) => {
      const proc = spawn("bash", ["-c", cmd], {
        cwd: (cwd as string | undefined) ?? process.cwd(),
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];

      proc.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      proc.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

      const timer = setTimeout(() => {
        proc.kill("SIGTERM");
        resolve({ success: false, output: "", error: `Command timed out after ${TIMEOUT_MS}ms` });
      }, TIMEOUT_MS);

      proc.on("close", (code) => {
        clearTimeout(timer);
        const out = Buffer.concat(stdout).toString("utf8").trimEnd();
        const err = Buffer.concat(stderr).toString("utf8").trimEnd();
        const combined = [out, err].filter(Boolean).join("\n");
        resolve({
          success: code === 0,
          output: combined,
          error: code !== 0 ? `Exited with code ${code}` : undefined,
        });
      });
    });
  },
};
