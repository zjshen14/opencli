# OpenCLI

A lightweight, open-source AI agent CLI that supports Google Gemini and Anthropic Claude models. Interact via natural-language prompts to perform developer tasks (code review, explanations, debugging, testing, and file operations) with explicit, auditable tool execution and safety checks.

> **Status**: Early prototype. Architecture spec in [`docs/architecture.md`](docs/architecture.md). Strategic direction in [`docs/roadmap.md`](docs/roadmap.md).

## Installation

```bash
npm install
```

## Setup

**Gemini** — set your API key in `.env`:

```bash
echo "GEMINI_API_KEY=your-key-here" > .env
```

**Claude (Anthropic)** — set your API key in `.env`:

```bash
echo "ANTHROPIC_API_KEY=your-key-here" > .env
```

Or configure permanently:

```bash
npm run dev -- config --api-key your-gemini-key
npm run dev -- config --anthropic-api-key your-anthropic-key
```

## Usage

**Interactive REPL:**
```bash
npm run dev
```

**One-shot prompt:**
```bash
npm run dev run "explain src/agent/core.ts"
```

**Select a model:**
```bash
# Gemini (default)
npm run dev -- chat --model gemini-3.1-pro-preview

# Claude
npm run dev -- chat --model claude-sonnet-4-6
```

**Set default model:**
```bash
npm run dev -- config --model claude-sonnet-4-6
```

## Skills

Invoke with `/skill-name [args]` or let the model auto-activate based on your request.

| Skill | Description |
|-------|-------------|
| `/review [target]` | Code review for correctness, security, and style |
| `/explain [target]` | Explain code, a concept, or a file |
| `/debug [error]` | Diagnose and fix a reported error |
| `/test [target]` | Write tests for a function or module |
| `/commit` | Draft and create a git commit from staged changes |

**Built-in commands:** `/help`, `/clear`, `/exit`

### Adding your own skills

Project-scoped (this repo only):
```bash
mkdir -p .opencli/skills/my-skill
```

User-global (all projects):
```bash
mkdir -p ~/.opencli/skills/my-skill
```

Create `SKILL.md` in the directory:

```yaml
---
name: my-skill
description: What it does and when to use it.
allowed-tools: Read Bash
---

Instructions for the agent...

Current git status:
!{git status --short}

Arguments: $ARGUMENTS
```

Skills follow the [Agent Skills open standard](https://agentskills.io) and are compatible with Claude Code and the official Gemini CLI.

## Tools

| Tool | Description |
|------|-------------|
| `read` | Read file contents with optional line range |
| `write` | Create or overwrite a file |
| `edit` | Exact string find-and-replace in a file |
| `glob` | Find files by pattern (e.g. `**/*.ts`) |
| `grep` | Regex search across file contents |
| `bash` | Run shell commands (blocks destructive patterns) |

## Development

```bash
npm run dev          # Run with tsx (auto-loads .env)
npm run build        # Bundle with tsup → dist/
npm run typecheck    # TypeScript type check
npm run lint         # ESLint
npm run lint:fix     # ESLint with auto-fix
npm test             # Vitest
```

## Configuration

Config is stored at `~/.opencli/config.json`.

| Option | Default | Description |
|--------|---------|-------------|
| `model` | `gemini-3.1-flash-lite-preview` | Model ID (Gemini or Claude) |
| `apiKey` | — | Gemini API key (prefer env var) |
| `anthropicApiKey` | — | Anthropic API key (prefer env var) |
| `temperature` | `0.7` | Generation temperature |
| `maxTokens` | `8192` | Max output tokens |
| `historySize` | `50` | Messages to keep in context |

Environment variables take precedence over config file:

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Gemini API key |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENCLI_MODEL` | Model override (beats `--model` and config) |
| `OPENCLI_SANDBOX` | Sandbox mode override: `auto` \| `strict` \| `off` |

## Sandbox isolation

The `bash` tool runs inside an OS-level sandbox by default (`--sandbox auto`):

- **macOS** — uses `sandbox-exec` (built-in, no install required). Network access is denied; writes outside the project root and `/tmp` are denied. Note: `sandbox-exec` is deprecated by Apple as of macOS 11 but remains functional through macOS 15. Container mode (planned for Phase C4) will be the production-grade alternative.
- **Linux** — uses `bwrap` (bubblewrap) via user namespaces. Same isolation contract. Falls back to passthrough with a warning if `bwrap` is not installed or user namespaces are disabled.
- **Windows / other** — no native sandbox; runs without isolation with a warning.

### Sandbox modes

| Mode | Behaviour |
|------|-----------|
| `auto` (default) | Network denied; writes allowed only inside CWD and `/tmp` |
| `strict` | Stub in A1 — falls back to `auto` with a warning. Full read-isolation planned for a future release. |
| `off` | No sandbox; bit-identical to pre-sandbox behaviour |

### Configuring the sandbox

```bash
# CLI flag (takes highest precedence)
opencli chat --sandbox off
opencli run --sandbox auto "list files"

# Environment variable
OPENCLI_SANDBOX=off opencli chat

# Config file (~/.opencli/config.json)
opencli config  # shows current config; edit sandbox field manually
```

## Architecture

Five-layer design — see [`docs/architecture.md`](docs/architecture.md) for the full spec.

```
CLI Layer  →  Agent Core  →  LLM Provider (Gemini / Claude)
                  ↓
          Tool System  |  Skill System  |  State
```
