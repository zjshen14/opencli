# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> **Keep in sync with `AGENTS.md`** — both files carry the same content; only the first-line header differs. Update both in the same commit whenever either changes.

## Project Overview

OpenCLI — an open-source AI agent CLI that supports Google Gemini and Anthropic Claude models, modeled after Claude Code. The implementation is a working prototype in TypeScript/Node.js (ESM, Node 20+).

## Commands

```bash
npm run dev               # Run interactive REPL (auto-loads .env)
npm run dev run "<prompt>"  # One-shot prompt
npm run build             # Bundle with tsup → dist/
npm run typecheck         # tsc --noEmit
npm run lint              # ESLint
npm run lint:fix          # ESLint with auto-fix
npm run format            # Prettier --write src/**/*.ts
npm run format:check      # Prettier check (no write)
npm test                  # Vitest
npm run test:single       # Vitest verbose (single run)
```

API keys are loaded from `.env` (`GEMINI_API_KEY` for Gemini models, `ANTHROPIC_API_KEY` for Claude models). Default model: `gemini-3.1-flash-lite-preview`.

## Source Structure

```
src/
  cli/            # Thin adapter — reads config/env, wires dependencies, runs the REPL
    index.ts        # Entry point — commander CLI (chat / run / sessions / config commands)
    repl.ts         # Interactive REPL, /slash command interception, skill loading, session logging
    renderer.ts     # MarkdownStreamRenderer (paragraph-level streaming), tool call display
    input.ts        # Raw-mode readline, /slash popup with arrow-key navigation
  core/           # Pure library — no process.env reads, no CLI/state imports
    agent.ts        # Agentic loop: stream → collect function calls → execute → feed back
    executor.ts     # Parallel tool execution, skill activation dispatch, HITL confirmation gate
    context.ts      # Conversation history, skill content injection, context pruning
    prompt.ts       # DEFAULT_SYSTEM_INSTRUCTION template + loadSystemInstruction() (OPENCLI_SYSTEM_MD)
  providers/      # LLM clients — no CLI/state imports
    types.ts        # Shared types: Message, StreamEvent, ToolDefinition, ToolResult, thoughtSignature
    client.ts       # LLMClient interface — the provider plug point
    gemini.ts       # GeminiClient implements LLMClient; Gemini-specific schema conversion internal
    anthropic.ts    # AnthropicClient implements LLMClient; translates role/tool formats internally
    factory.ts      # createClient(model, apiKey) — picks provider by model name prefix
    schema.ts       # Generic toolToDefinition() + activateSkillDefinition (plain JSONSchema, no provider deps)
  tools/
    base.ts         # Tool interface + JSONSchema type
    registry.ts     # ToolRegistry: register, execute, list
    file/           # read, write, edit, glob, grep
    exec/           # bash (with requiresConfirmation for non-safe commands)
    think.ts        # think tool — private scratchpad; skipped for native-thinking models
    index.ts        # createDefaultRegistry(model?) factory — omits think for native-thinking models
  skills/
    registry.ts     # Discover SKILL.md files across 4 scoped directories
    loader.ts       # Parse SKILL.md frontmatter, !{cmd} preprocessing, $ARGUMENTS substitution
    builtin/        # review, commit, explain, debug, test, gh-issue, gh-pr, branch, run-tests, typecheck, lint, new-skill
  state/
    config.ts       # ~/.opencli/config.json load/save; exports AGENT_DIR, Config (incl. anthropicApiKey)
    session.ts      # JSONL session logs at ~/.opencli/projects/<cwd>/; create, list, resume
```

## Architecture

**Data flow**: User input → CLI Layer → Agent Core → LLM provider (streaming) → Tool/Skill execution → feed results back → repeat until final text response.

**Agentic loop** (`src/core/agent.ts`):
1. Add user message to context
2. Stream from the active `LLMClient` with tool + `activate_skill` definitions (filtered to read-only tools in plan mode)
3. Collect text chunks (display immediately) and function calls
4. Execute all tool calls in parallel (`Promise.all`); skill activations inject content into context; write tools are blocked when `readOnly` is set (plan mode)
   - Before each execution, check `tool.requiresConfirmation(args)`; if true, invoke `confirmFn` (interactive y/n/always dialog in REPL; auto-deny in non-interactive mode unless `--yes`)
5. Append event-driven reminders to the last tool result (e.g. after `edit` → "run tests")
6. Feed results back as a user message; repeat from step 2 until no function calls
7. **Safety guards**: max-turns limit (default 50, `--max-turns` to override); stuck-loop detection aborts after 3 identical consecutive call signatures

**Plan mode** (`Agent.run(input, "plan")`): restricts tools to `read/glob/grep/think`, appends a plan-specific system prompt suffix, and sets `readOnly` on the executor so write tools are blocked at two layers. The REPL's `/plan <task>` command runs a plan pass, then shows `[@clack/prompts select]` Approve / Edit / Cancel before switching to react mode for execution.

**Provider abstraction**: `LLMClient` (in `providers/client.ts`) is the single interface the Agent Core depends on. `schema.ts` converts `Tool` objects to generic `ToolDefinition` (plain JSONSchema). Each provider client translates `ToolDefinition[]` and `Message[]` into its own wire format internally — Gemini converts types to uppercase and uses `functionCall`/`functionResponse`; Anthropic maps `role: "model"` → `"assistant"` and uses `tool_use`/`tool_result` blocks. The provider is selected by `createClient(model, apiKey)` in `factory.ts` based on model name prefix (`claude-` → Anthropic, otherwise Gemini). API key resolution (env vars + config file) happens in `cli/index.ts` — the library layer never reads `process.env` or config files.

**Thinking models + `thoughtSignature`**: Gemini thinking models (e.g. `gemini-3.1-*`) require `thoughtSignature` to be captured from each `functionCall` part and echoed back in the corresponding `functionResponse`. This is threaded through `FunctionCallPart` → `FunctionResultPart` → the API request in `gemini.ts`. The Anthropic client ignores this field.

**Skill system**: Skills are `SKILL.md` files (YAML frontmatter + Markdown instructions) injected into the agent context on activation. They follow the [Agent Skills open standard](https://agentskills.io). Discovery priority: project `.opencli/skills/` → project `.agents/skills/` → user `~/.opencli/skills/` → bundled built-ins. Invoke with `/skill-name [args]` or the model calls `activate_skill`. See [`docs/skills.md`](docs/skills.md) for the full authoring guide.

**When adding, removing, or renaming a built-in skill**, update all four places: `docs/skills.md` (built-in table), `docs/architecture.md` (skill list + file tree), and the `builtin/` comment in both `CLAUDE.md` and `AGENTS.md`.

## Key Conventions

- All tools return `{ success: boolean; output: string; error?: string }`
- Tools declare `requiresConfirmation?(args) => boolean` on their interface; the executor calls `confirmFn` when it returns true. Bash requires confirmation for any command not in its `SAFE_COMMANDS` allowlist; `write`/`edit` require it for paths outside `process.cwd()`.
- `edit` tool requires `old_string` to appear exactly once — fails with a clear error if ambiguous
- Prettier `printWidth: 100`, double quotes, trailing commas — run `npm run format` before committing
- ESLint: `@typescript-eslint/recommended` + no unused vars (underscore prefix to suppress)

**Before submitting any change**, run:
```bash
npm run typecheck && npm run lint && npm run format:check && npm test
```

**Full engineering practices are in [`docs/engineering-practices.md`](docs/engineering-practices.md).** Check it before writing code. Key rules:
- Colocate tests next to source (`context.ts` → `context.test.ts`)
- Each layer owns its concern — `providers/` never touches filesystem, `tools/` never imports provider SDKs
- No circular imports: `cli → core/providers/tools/skills/state`
- `core/` and `providers/` must never import from `cli/` or `state/` — API keys and config are resolved by the CLI layer and passed as constructor arguments
- Mock at system boundaries only; use real filesystem for file tool tests
- Document non-obvious decisions in `docs/`

## Issue Management & Branching

- **Always check for a related GitHub issue.** If your work addresses an issue, format your commit message to include `Closes #<issue_number>` (if fully resolved) or `Part of #<issue_number>` (if partial).
- **If you forget to link an issue in the commit message**, use the GitHub CLI to comment on the issue with the commit hash.
- **After completing each phase of a multi-phase issue**, post a comment on the issue summarising what landed (commit hash, what changed, what remains open). Don't wait until the issue is fully closed — intermediate updates keep the issue as the canonical record of progress.
- **Before starting a complex or risky task**, explicitly ask the user if they would prefer you to create a feature branch (`git checkout -b feature/issue-123`) instead of committing directly to `main`. Small, well-scoped fixes should be committed directly to `main`.

## Configuration

- `.env` — `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENCLI_MODEL`
- `OPENCLI_SYSTEM_MD` — path to a Markdown file that overrides the default system instruction (for prompt hill-climbing)
- `OPENCLI_MAX_TOOL_OUTPUT` — max chars before bash/grep/glob output is middle-truncated (default: 20 000)
- `~/.opencli/config.json` — persisted user config (model, temperature, historySize, etc.)
- `~/.opencli/projects/<encoded-cwd>/<session-id>.jsonl` — session conversation logs
- `.gitignore` excludes `.env` and `dist/`

## Session Management

Sessions are JSONL logs stored globally (not in the project directory):

```bash
opencli sessions              # list sessions for current directory
opencli chat --resume         # resume most recent session with conversation content
opencli chat --session <id>   # resume a specific session by ID
```

Session ID format: `YYYY-MM-DDTHH-mm-ss` (human-readable, lexicographically sortable).
