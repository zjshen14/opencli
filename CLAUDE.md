# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

An unofficial Gemini Agent CLI — a general-purpose AI agent CLI powered by Google Gemini, modeled after Claude Code. The implementation is a working prototype in TypeScript/Node.js (ESM, Node 20+).

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

API key is loaded from `.env` (`GEMINI_API_KEY`). Default model: `gemini-3.1-flash-lite-preview`.

## Source Structure

```
src/
  cli/
    index.ts        # Entry point — commander CLI (chat / run / config commands)
    repl.ts         # Interactive REPL, /slash command interception, skill loading
    renderer.ts     # Streaming output, markdown rendering, tool call display
  agent/
    core.ts         # Agentic loop: stream → collect function calls → execute → feed back
    executor.ts     # Parallel tool execution + skill activation dispatch
    context.ts      # Conversation history, skill content injection, context pruning
  model/
    types.ts        # Shared types: Message, StreamEvent, ToolResult, thoughtSignature
    gemini.ts       # Gemini streaming client, exponential backoff retry
    schema.ts       # Tool → FunctionDeclaration translator + activate_skill declaration
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
    config.ts       # ~/.gemini-agent/config.json load/save, API key resolution
```

## Architecture

**Data flow**: User input → CLI Layer → Agent Core → Gemini API (streaming) → Tool/Skill execution → feed results back → repeat until final text response.

**Agentic loop** (`src/agent/core.ts`):
1. Add user message to context
2. Stream from Gemini with all tool + `activate_skill` function declarations
3. Collect text chunks (display immediately) and function calls
4. Execute all tool calls in parallel (`Promise.all`); skill activations inject content into context
5. Feed results back as a user message; repeat from step 2 until no function calls

**Function calling vs tools**: The Model Layer owns the Gemini API wire protocol (translating `Tool` → `function_declarations`, parsing `functionCall` responses). The Tool System owns execution and knows nothing about Gemini. Swapping the LLM only requires changes to the Model Layer.

**Thinking models + `thoughtSignature`**: Gemini thinking models (e.g. `gemini-3.1-*`) require `thoughtSignature` to be captured from each `functionCall` part and echoed back in the corresponding `functionResponse`. This is threaded through `FunctionCallPart` → `FunctionResultPart` → the API request in `gemini.ts`.

**Skill system**: Skills are `SKILL.md` files (YAML frontmatter + Markdown instructions) injected into the agent context on activation. They follow the [Agent Skills open standard](https://agentskills.io). Discovery priority: project `.gemini-agent/skills/` → project `.agents/skills/` → user `~/.gemini-agent/skills/` → bundled built-ins. Invoke with `/skill-name [args]` or the model calls `activate_skill`.

## Key Conventions

- All tools return `{ success: boolean; output: string; error?: string }`
- Dangerous bash patterns (e.g. `rm -rf`, `git push --force`) are blocked at the tool level
- `edit` tool requires `old_string` to appear exactly once — fails with a clear error if ambiguous
- Prettier `printWidth: 100`, double quotes, trailing commas — run `npm run format` before committing
- ESLint: `@typescript-eslint/recommended` + no unused vars (underscore prefix to suppress)

**Before submitting any change**, run:
```bash
npm run typecheck && npm run lint && npm test
```

**Full engineering practices are in [`docs/engineering-practices.md`](docs/engineering-practices.md).** Check it before writing code. Key rules:
- Colocate tests next to source (`context.ts` → `context.test.ts`)
- Each layer owns its concern — `model/` never touches filesystem, `tools/` never imports `@google/genai`
- No circular imports: `cli → agent → model/tools/skills/state`
- Mock at system boundaries only; use real filesystem for file tool tests
- Document non-obvious decisions in `docs/`

## Configuration

- `.env` — `GEMINI_API_KEY`, `GEMINI_MODEL`
- `~/.gemini-agent/config.json` — persisted user config (model, temperature, historySize, etc.)
- `.gitignore` excludes `.env` and `dist/`
