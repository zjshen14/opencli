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
import type { ToolDefinition } from "../providers/types.js";

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
    text: "verify the change works — find and run the project's test command before reporting done",
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
  firedReminders?: Set<string>,
): string {
  const triggered = AGENT_REMINDERS.filter((r) => {
    if (firedReminders?.has(r.text)) return false;
    return r.shouldFire(calls);
  });
  if (triggered.length === 0) return "";
  triggered.forEach((r) => firedReminders?.add(r.text));
  return `\n\n[reminder: ${triggered.map((r) => r.text).join("; ")}]`;
}

// ── System instruction rendering ─────────────────────────────────────────────

export interface SystemInstructionContext {
  cwd: string;
  tmpDir: string;
  tools: ToolDefinition[];
  gitContext: string;
  skillCatalog?: string;
}

export function renderSystemInstruction(template: string, ctx: SystemInstructionContext): string {
  const toolCatalog =
    ctx.tools.length > 0
      ? `## Available Tools\n\n${ctx.tools
          .map((t) => {
            const schema = t.parameters as {
              properties?: Record<string, { description?: string; type?: string }>;
              required?: string[];
            };
            const props = schema?.properties ?? {};
            const required = new Set(schema?.required ?? []);
            const paramLines = Object.entries(props)
              .map(
                ([k, v]) =>
                  `  - ${k}${required.has(k) ? " (required)" : ""}: ${v.description ?? v.type ?? ""}`,
              )
              .join("\n");
            return `### ${t.name}\n${t.description ?? ""}${paramLines ? `\n${paramLines}` : ""}`;
          })
          .join("\n\n")}`
      : "";
  return template
    .replaceAll("{CWD}", ctx.cwd)
    .replaceAll("{SESSION_TMP}", ctx.tmpDir)
    .replaceAll("{TOOL_CATALOG}", toolCatalog)
    .replaceAll("{GIT_CONTEXT}", ctx.gitContext ? ctx.gitContext + "\n\n" : "")
    .replaceAll("{SKILL_CATALOG}", ctx.skillCatalog ? ctx.skillCatalog + "\n\n" : "");
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
All other tools are blocked at the executor level.

### Process

1. **Understand** — Restate the goal in one sentence. Make assumptions explicit; do not ask the user clarifying questions (flag any uncertainties in the Risks section instead).
2. **Explore** — Use glob/grep to map relevant files, then read the ones most central to the task. Follow imports as needed. Skip files you don't need.
3. **Design** — Use think to reason about the approach, constraints, and alternatives.
4. **Plan** — Output the final plan in the format below, then stop.

### Output format

## Plan: <short title>

- [1] **<step title>** — \`path/to/file.ts\` — one-line description
- [2] **<step title>** — \`path/to/file.ts\` — one-line description
- [N] **Verify** — \`npm test\` (or relevant command)

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

For non-trivial tasks:
1. **Research** — map the codebase, validate assumptions with targeted searches, reproduce issues before fixing them
2. **Plan** — use \`think\` to reason through multi-file changes before acting; confirm with the user only if the approach is genuinely ambiguous
3. **Execute** — implement in focused steps, verifying each change before moving on

For simple, well-scoped tasks, act directly without narrating the plan.

## Verification

After every code change:
1. Discover the project's toolchain — check README, Makefile, package.json, pyproject.toml, Cargo.toml, go.mod, or equivalent. Do this once per task and remember it.
2. Run the relevant build and test commands for the language and toolchain.
3. If they fail: read the full error output, identify the root cause, fix it, re-run.
4. Do not report success until build and tests pass.
5. If three different fixes all fail, stop and describe what you tried and why each failed.

## Engineering Standards

- Read files before editing; prefer targeted edits over full rewrites
- Follow existing conventions, naming, and architecture — never impose a new style
- Never disable linters, type checks, or silence warnings without explicit instruction
- After changing code, update related tests; add new tests for new behaviour
- Don't add features, refactoring, or comments beyond what was asked
- Verify a dependency exists in the project before using it

## Tool Usage

- **Batch independent tool calls in one response.** Each separate LLM turn is a 20-50 second round-trip; emitting six \`read\` calls across six turns wastes minutes of wall time. Always batch when you can: multiple \`read\` / \`glob\` / \`grep\` / \`ls\` / \`web_fetch\` calls, and multiple \`write\` calls for files whose contents don't depend on each other. Don't batch when there's a real ordering dependency: multiple \`edit\` calls on the same file, or any sequence where one tool's output determines the next tool's args.
  - Example: when exploring a component, emit \`read\` calls for \`Navbar.tsx\`, \`Footer.tsx\`, \`layout.tsx\`, \`page.tsx\` together in one response — not one per turn.
- Use \`grep\`/\`glob\` to locate code before reading whole files; never read a file you don't need
- One \`edit\` call per file per turn to avoid conflicts
- **edit**: always \`read\` the file first; \`old_string\` must match exactly — whitespace and indentation included; if it fails with "not found", re-read and try again with the exact content
- **bash**: if a command fails, read the full error output before retrying; never retry unchanged
- **bash long-running servers**: use \`nohup CMD > log 2>&1 < /dev/null &\` to background dev servers and daemons — all three FDs must be redirected so the shell can return immediately. Never end an \`&&\` chain with a backgrounded long-running command (e.g. \`A && B && server &\`) — the backgrounded subshell inherits stdio pipes and the call will hang until timeout. After starting, verify with \`sleep 2 && curl -s localhost:PORT\` or \`tail log\`.
- **think**: use before starting any change that touches more than two files; reason through the approach and order of changes
- **todo_write**: for tasks with more than three steps, write the steps first and check them off as you go

## Exploration

When working in an unfamiliar codebase:
1. Read root-level files (README, package.json, Makefile, or equivalent) to understand structure and commands
2. Use \`glob\` to map the file layout; trace imports to find where things are defined
3. Read test files — they show expected behaviour and how components are used
4. Use \`grep -n\` to find symbol definitions; understand interfaces before changing implementations

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
- For scratch files, write to {SESSION_TMP}/ and clean up when done

{SKILL_CATALOG}{TOOL_CATALOG}`;

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
