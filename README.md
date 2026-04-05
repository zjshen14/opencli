# Gemini Agent CLI

A lightweight, unofficial CLI agent powered by Google Gemini. Interact via natural-language prompts to perform developer tasks (code review, explanations, debugging, testing, and file operations) with explicit, auditable tool execution and safety checks.

> **Status**: Early prototype. Architecture spec in [`docs/architecture.md`](docs/architecture.md).

## Installation

```bash
npm install
```

## Setup

Set your Gemini API key in `.env`:

```bash
echo "GEMINI_API_KEY=your-key-here" > .env
```

Or configure it permanently:

```bash
npm run dev -- config --api-key your-key-here
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

**Change model:**
```bash
npm run dev -- config --model gemini-3.1-pro-preview
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
mkdir -p .gemini-agent/skills/my-skill
```

User-global (all projects):
```bash
mkdir -p ~/.gemini-agent/skills/my-skill
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

Config is stored at `~/.gemini-agent/config.json`.

| Option | Default | Description |
|--------|---------|-------------|
| `model` | `gemini-3.1-flash-lite-preview` | Gemini model ID |
| `temperature` | `0.7` | Generation temperature |
| `maxTokens` | `8192` | Max output tokens |
| `historySize` | `50` | Messages to keep in context |

Environment variables take precedence: `GEMINI_API_KEY`, `GEMINI_MODEL`.

## Architecture

Five-layer design — see [`docs/architecture.md`](docs/architecture.md) for the full spec.

```
CLI Layer  →  Agent Core  →  Gemini API
                  ↓
          Tool System  |  Skill System  |  State
```
