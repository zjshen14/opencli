# AGENTS.md

This file provides guidance to Codex (Codex.ai/code) when working with code in this repository.

## Project Overview

OpenCLI — an open-source AI agent CLI that supports Google Gemini and Anthropic Codex models, modeled after Codex. The implementation is a working prototype in TypeScript/Node.js (ESM, Node 20+).

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

API keys are loaded from `.env` (`GEMINI_API_KEY` for Gemini models, `ANTHROPIC_API_KEY` for Codex models). Default model: `gemini-3.1-flash-lite-preview`.

## Source Structure

```
src/
  cli/
    index.ts        # Entry point — commander CLI (chat / run / sessions / config commands)
    repl.ts         # Interactive REPL, /slash command interception, skill loading, session logging
    renderer.ts     # MarkdownStreamRenderer (paragraph-level streaming), tool call display
    input.ts        # Raw-mode readline, /slash popup with arrow-key navigation
  agent/
    core.ts         # Agentic loop: stream → collect function calls → execute → feed back
    executor.ts     # Parallel tool execution + skill activation dispatch
    context.ts      # Conversation history, skill content injection, context pruning
    prompt.ts       # DEFAULT_SYSTEM_INSTRUCTION template + loadSystemInstruction() (OPENCLI_SYSTEM_MD)
  model/
    types.ts        # Shared types: Message, StreamEvent, ToolDefinition, ToolResult, thoughtSignature
    client.ts       # LLMClient interface — the provider plug point
    gemini.ts       # GeminiClient implements LLMClient; Gemini-specific schema conversion internal
    anthropic.ts    # AnthropicClient implements LLMClient; translates role/tool formats internally
    factory.ts      # createClient(model, config) — picks provider by model name prefix
    schema.ts       # Generic toolToDefinition() + activateSkillDefinition (plain JSONSchema, no provider deps)
  tools/
    base.ts         # Tool interface + JSONSchema type
    registry.ts     # ToolRegistry: register, execute, list
    file/           # read, write, edit, glob, grep
    exec/           # bash (with dangerous-command guard)
    index.ts        # createDefaultRegistry() factory
  skills/
    registry.ts     # Discover SKILL.md files across 4 scoped directories
    loader.ts       # Parse SKILL.md frontmatter, !{cmd} preprocessing, $ARGUMENTS substitution
    builtin/        # review, commit, explain, debug, test
  state/
    config.ts       # ~/.opencli/config.json load/save; exports AGENT_DIR, Config (incl. anthropicApiKey)
    session.ts      # JSONL session logs at ~/.opencli/projects/<cwd>/; create, list, resume
```

## Architecture

**Data flow**: User input → CLI Layer → Agent Core → LLM provider (streaming) → Tool/Skill execution → feed results back → repeat until final text response.

**Agentic loop** (`src/agent/core.ts`):
1. Add user message to context
2. Stream from the active `LLMClient` with all tool + `activate_skill` definitions
3. Collect text chunks (display immediately) and function calls
4. Execute all tool calls in parallel (`Promise.all`); skill activations inject content into context
5. Feed results back as a user message; repeat from step 2 until no function calls

**Provider abstraction**: `LLMClient` (in `model/client.ts`) is the single interface the Agent Core depends on. `schema.ts` converts `Tool` objects to generic `ToolDefinition` (plain JSONSchema). Each provider client translates `ToolDefinition[]` and `Message[]` into its own wire format internally — Gemini converts types to uppercase and uses `functionCall`/`functionResponse`; Anthropic maps `role: "model"` → `"assistant"` and uses `tool_use`/`tool_result` blocks. The provider is selected by `createClient()` in `factory.ts` based on model name prefix (`Codex-` → Anthropic, otherwise Gemini).

**Thinking models + `thoughtSignature`**: Gemini thinking models (e.g. `gemini-3.1-*`) require `thoughtSignature` to be captured from each `functionCall` part and echoed back in the corresponding `functionResponse`. This is threaded through `FunctionCallPart` → `FunctionResultPart` → the API request in `gemini.ts`. The Anthropic client ignores this field.

**Skill system**: Skills are `SKILL.md` files (YAML frontmatter + Markdown instructions) injected into the agent context on activation. They follow the [Agent Skills open standard](https://agentskills.io). Discovery priority: project `.opencli/skills/` → project `.agents/skills/` → user `~/.opencli/skills/` → bundled built-ins. Invoke with `/skill-name [args]` or the model calls `activate_skill`.

## Key Conventions

- All tools return `{ success: boolean; output: string; error?: string }`
- Dangerous bash patterns (e.g. `rm -rf`, `git push --force`) are blocked at the tool level
- `edit` tool requires `old_string` to appear exactly once — fails with a clear error if ambiguous
- Prettier `printWidth: 100`, double quotes, trailing commas — run `npm run format` before committing
- ESLint: `@typescript-eslint/recommended` + no unused vars (underscore prefix to suppress)

**Before submitting any change**, run:
```bash
npm run typecheck && npm run lint && npm run format:check && npm test
```

**Full engineering practices are in [`docs/engineering-practices.md`](docs/engineering-practices.md).** Check it before writing code. Key rules:
- Colocate tests next to source (`context.ts` → `context.test.ts`)
- Each layer owns its concern — `model/` never touches filesystem, `tools/` never imports provider SDKs
- No circular imports: `cli → agent → model/tools/skills/state`
- Mock at system boundaries only; use real filesystem for file tool tests
- Document non-obvious decisions in `docs/`

## Issue Management & Branching

- **Always check for a related GitHub issue.** If your work addresses an issue, format your commit message to include `Closes #<issue_number>` (if fully resolved) or `Part of #<issue_number>` (if partial).
- **If you forget to link an issue in the commit message**, use the GitHub CLI to comment on the issue with the commit hash.
- **Before starting a complex or risky task**, explicitly ask the user if they would prefer you to create a feature branch (`git checkout -b feature/issue-123`) instead of committing directly to `main`. Small, well-scoped fixes should be committed directly to `main`.

## Configuration

- `.env` — `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENCLI_MODEL`
- `OPENCLI_SYSTEM_MD` — path to a Markdown file that overrides the default system instruction (for prompt hill-climbing)
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
