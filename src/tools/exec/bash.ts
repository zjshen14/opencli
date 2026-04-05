import { spawn } from "node:child_process";
import type { Tool } from "../base.js";

const TIMEOUT_MS = 30_000;

// Commands that require user confirmation before executing
const DANGEROUS_PATTERNS = [
  /rm\s+-rf/,
  /git\s+push\s+--force/,
  /git\s+reset\s+--hard/,
  /:\s*>\s*\S+/, // truncate file
  /mkfs/,
  /dd\s+if=/,
  /chmod\s+-R\s+777/,
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
  async execute({ command, cwd }) {
    const cmd = command as string;

    for (const pattern of DANGEROUS_PATTERNS) {
      if (pattern.test(cmd)) {
        return {
          success: false,
          output: "",
          error: `Refusing to execute potentially destructive command. Pattern matched: ${pattern}`,
        };
      }
    }

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
