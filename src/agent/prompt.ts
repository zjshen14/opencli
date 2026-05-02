/**
 * Default system instruction template.
 *
 * Placeholders substituted at runtime:
 *   {CWD}          — absolute path of the working directory
 *   {SESSION_TMP}  — session-scoped scratch directory
 *   {TOOL_CATALOG} — injected list of available tools
 *
 * To use a custom instruction without recompiling, set OPENCLI_SYSTEM_MD to a
 * Markdown file path. The same placeholders are supported in custom files.
 */

import { readFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import type { ToolDefinition } from "../model/types.js";

export function getGitContext(): string {
  try {
    const run = (cmd: string) =>
      execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], timeout: 3000 }).trim();

    const branch = run("git branch --show-current");
    if (!branch) return ""; // detached HEAD — not useful to inject

    let defaultBranch = branch;
    try {
      defaultBranch = run("git symbolic-ref refs/remotes/origin/HEAD --short").replace(
        /^origin\//,
        "",
      );
    } catch {
      /* no remote configured */
    }

    const statusRaw = run("git status --short");
    const status = statusRaw || "(clean)";
    const cappedStatus = status.length > 2000 ? status.slice(0, 2000) + "\n[...truncated]" : status;

    const log = run("git log --oneline -5");

    const parts = [
      `Branch: ${branch}${defaultBranch !== branch ? `  •  Default: ${defaultBranch}` : ""}`,
      `Status:\n${cappedStatus
        .split("\n")
        .map((l) => `  ${l}`)
        .join("\n")}`,
    ];
    if (log) {
      parts.push(
        `Recent commits:\n${log
          .split("\n")
          .map((l) => `  ${l}`)
          .join("\n")}`,
      );
    }

    return `## Repository\n_Snapshot at session start — will not update during the conversation._\n${parts.join("\n")}`;
  } catch {
    return ""; // not a git repo or git unavailable
  }
}

// ── Event-driven reminders ────────────────────────────────────────────────────

export interface AgentReminder {
  text: string;
  shouldFire: (calls: ReadonlyArray<{ name: string; args: Record<string, unknown> }>) => boolean;
}

export const AGENT_REMINDERS: AgentReminder[] = [
  {
    text: "run tests after making code changes",
    shouldFire: (calls) => calls.some((c) => c.name === "write" || c.name === "edit"),
  },
  {
    text: "never commit or push without an explicit user request",
    shouldFire: (calls) =>
      calls.some((c) => c.name === "bash" && String(c.args.command ?? "").includes("git")),
  },
  {
    text: "don't add features or refactoring beyond what was asked",
    shouldFire: (calls) => calls.some((c) => c.name === "write" || c.name === "edit"),
  },
];

export function buildReminder(
  calls: ReadonlyArray<{ name: string; args: Record<string, unknown> }>,
): string {
  const triggered = AGENT_REMINDERS.filter((r) => r.shouldFire(calls)).map((r) => r.text);
  if (triggered.length === 0) return "";
  return `\n\n[reminder: ${triggered.join("; ")}]`;
}

// ── System instruction rendering ─────────────────────────────────────────────

export interface SystemInstructionContext {
  cwd: string;
  tmpDir: string;
  tools: ToolDefinition[];
  gitContext: string;
}

export function renderSystemInstruction(template: string, ctx: SystemInstructionContext): string {
  const toolCatalog =
    ctx.tools.length > 0
      ? `## Available Tools\n${ctx.tools.map((t) => `- ${t.name}: ${t.description ?? ""}`).join("\n")}`
      : "";
  return template
    .replaceAll("{CWD}", ctx.cwd)
    .replaceAll("{SESSION_TMP}", ctx.tmpDir)
    .replaceAll("{TOOL_CATALOG}", toolCatalog)
    .replaceAll("{GIT_CONTEXT}", ctx.gitContext ? ctx.gitContext + "\n\n" : "");
}

export function buildPlanSuffix(allowedTools: ReadonlySet<string>): string {
  const toolList = [...allowedTools]
    .filter((t) => t !== "activate_skill")
    .map((t) => `\`${t}\``)
    .join(", ");

  return `

## Plan Mode

You are in **Plan Mode**. Your only task is to explore the codebase and produce a concrete numbered execution plan. You CANNOT and MUST NOT modify any files.

Available tools: ${toolList}.
Write tools (\`write\`, \`edit\`, \`bash\`, \`todo_write\`) are blocked at the executor level.

### Process

1. **Understand** — Restate the goal in one sentence. Make assumptions explicit; do not ask the user clarifying questions (flag any uncertainties in the Risks section instead).
2. **Explore** — Use glob/grep to map relevant files, then read the ones most central to the task. Follow imports as needed. Skip files you don't need.
3. **Design** — Use think to reason about the approach, constraints, and alternatives.
4. **Plan** — Output the final plan in the format below, then stop.

### Output format

## Plan: <short title>

- [ ] 1. **<step title>** — \`path/to/file.ts\` — one-line description
- [ ] 2. **<step title>** — \`path/to/file.ts\` — one-line description
- [ ] N. **Verify** — \`npm test\` (or relevant command)

### Critical files
- \`path/to/file1.ts\` — why this is central
- \`path/to/file2.ts\` — why

### Risks / assumptions
- ⚠️ <risk or unverified assumption — one line>

### Rules

- 3–10 steps for most tasks
- Each step must name a specific file path
- Use ⚠️ for any step that depends on an unverified assumption
- Do NOT include full file contents or large code blocks
- Do NOT begin execution — stop after producing the plan`;
}

// ── System instruction template ───────────────────────────────────────────────

export const DEFAULT_SYSTEM_INSTRUCTION = `You are OpenCLI, an expert software engineer working as a senior peer programmer in the user's terminal.
Working directory: {CWD}

{GIT_CONTEXT}

## Workflow

For non-trivial tasks, follow this three-phase approach:
1. **Research** — map the codebase, validate assumptions with targeted searches, reproduce issues before fixing them
2. **Plan** — form a concrete, grounded strategy; confirm with the user if the approach is ambiguous
3. **Execute** — implement in focused steps, validate each change (build, lint, tests) before moving on

For simple tasks, act directly without narrating the plan.

## Engineering Standards

- Read files before editing them; prefer targeted edits over full rewrites
- Follow existing code conventions, naming, and architecture — never impose a new style
- Never disable linters, bypass type checks, or silence warnings without explicit instruction
- After changing code, update related tests; add new tests for new behaviour
- Don't add features, refactoring, or comments beyond what was asked
- Verify a library is already in the project before using it

## Tool Usage

- Run independent tool calls in parallel (searches, reads, lookups)
- Prefer targeted tools — use grep/glob to locate code before reading whole files; never read a file you don't need
- One edit call per file per turn to avoid conflicts

## Git

- Never stage, commit, or push without an explicit user request
- When asked to commit: check \`git diff\`, draft a concise message, confirm before running
- Never force-push; always create new commits rather than amending published ones

## Security

- Never read, log, or expose credentials, API keys, or \`.env\` files
- Warn before executing destructive shell operations (rm -rf, DROP TABLE, etc.)

## Tone

- Respond like a senior peer: direct, precise, no filler ("Sure!", "Great!", "Certainly!")
- Lead with the action or answer, not the explanation
- Keep responses short — a few lines for simple tasks; detailed only when complexity demands it
- No emojis unless the user uses them first

## Files

- If the user asks to *see* or *show* code, respond with a code block — do NOT write a file
- If the user asks to *create* or *write* a file, write it to the project directory
- For scratch files you need temporarily, write to {SESSION_TMP}/ and clean up when done

{TOOL_CATALOG}`;

/**
 * Resolves the system instruction to use.
 * If OPENCLI_SYSTEM_MD is set, loads that file; otherwise returns the default.
 */
export async function loadSystemInstruction(): Promise<string> {
  const override = process.env.OPENCLI_SYSTEM_MD;
  if (override) {
    return readFile(override, "utf8");
  }
  return DEFAULT_SYSTEM_INSTRUCTION;
}
