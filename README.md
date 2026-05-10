<div align="center">

# 🤖 OpenCLI

**An open-source, model-agnostic AI coding agent for your terminal**

Works with Google Gemini · Anthropic Claude · Any OpenAI-compatible provider

[![npm version](https://img.shields.io/npm/v/@zjshen/opencli)](https://www.npmjs.com/package/@zjshen/opencli)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/zjshen14/opencli/actions/workflows/ci.yml/badge.svg)](https://github.com/zjshen14/opencli/actions)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.6-green.svg)](https://nodejs.org)

[Quick Start](#quick-start) · [Features](#features) · [Why OpenCLI?](#why-opencli) · [Skills](#skills) · [Contributing](CONTRIBUTING.md)

</div>

---

<!-- TODO: Replace with actual demo recording (use asciinema or VHS) -->
<!-- <div align="center">
  <img src="docs/assets/demo.gif" alt="OpenCLI demo" width="800">
</div> -->

## Quick Start

```bash
# Install globally
npm install -g @zjshen/opencli

# Set your API key
export GEMINI_API_KEY="your-key-here"
# or
export ANTHROPIC_API_KEY="your-key-here"

# Start the interactive REPL
opencli
```

Or try it instantly with `npx`:

```bash
npx @zjshen/opencli
```

## Features

- 🔀 **Model-agnostic** — Switch between Gemini, Claude, or any OpenAI-compatible provider with a flag
- 🛡️ **Sandboxed execution** — OS-level isolation for shell commands (macOS `sandbox-exec`, Linux `bwrap`)
- 🧩 **Extensible skills** — Compatible with the [Agent Skills open standard](https://agentskills.io) (works with Claude Code & Gemini CLI skills)
- 📋 **Plan mode** — Review and approve changes before they're applied (`/plan <task>`)
- 🔍 **Auditable tool use** — Every file read, write, and shell command is explicit and confirmable
- 💬 **Session management** — Resume conversations across sessions
- ⚡ **Lightweight** — No heavy framework, just `npm install` and go

## Why OpenCLI?

| | OpenCLI | Claude Code | Gemini CLI | Aider |
|---|:---:|:---:|:---:|:---:|
| **Model-agnostic** | ✅ Any provider | ❌ Claude only | ❌ Gemini only | ✅ Multiple |
| **Open source** | ✅ MIT | ❌ Proprietary | ✅ Apache-2.0 | ✅ Apache-2.0 |
| **Sandboxed execution** | ✅ OS-level | ❌ | ❌ | ❌ |
| **Extensible skills** | ✅ Agent Skills | ✅ Slash commands | ✅ Agent Skills | ❌ |
| **Plan → Review → Execute** | ✅ | ✅ | ❌ | ❌ |
| **Lightweight (zero config)** | ✅ | ✅ | ✅ | ⚠️ Git required |

## Usage

**Interactive REPL:**
```bash
opencli
# or
npm run dev
```

**One-shot prompt:**
```bash
opencli run "explain src/core/agent.ts"
```

**Select a model:**
```bash
# Gemini (default)
opencli chat --model gemini-3.1-pro-preview

# Claude
opencli chat --model claude-sonnet-4-6
```

**Set default model:**
```bash
opencli config --model claude-sonnet-4-6
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

### Adding Your Own Skills

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

## Sandbox Isolation

The `bash` tool runs inside an OS-level sandbox by default (`--sandbox auto`):

- **macOS** — uses `sandbox-exec` (built-in, no install required). Network access is denied; writes outside the project root and `/tmp` are denied.
- **Linux** — uses `bwrap` (bubblewrap) via user namespaces. Same isolation contract. Falls back to passthrough with a warning if `bwrap` is not installed.
- **Windows / other** — no native sandbox; runs without isolation with a warning.

| Mode | Behaviour |
|------|-----------|
| `auto` (default) | Network denied; writes allowed only inside CWD and `/tmp` |
| `strict` | Falls back to `auto` with a warning (full isolation planned) |
| `off` | No sandbox |

```bash
# CLI flag
opencli chat --sandbox off

# Environment variable
OPENCLI_SANDBOX=off opencli chat

# Config file
opencli config  # shows current config
```

## Architecture

Five-layer design — see [`docs/architecture.md`](docs/architecture.md) for the full spec.

```
CLI Layer  →  Agent Core  →  LLM Provider (Gemini / Claude)
                  ↓
          Tool System  |  Skill System  |  State
```

## Development

```bash
npm run dev          # Run with tsx (auto-loads .env)
npm run build        # Bundle with tsup → dist/
npm run typecheck    # TypeScript type check
npm run lint         # ESLint
npm run lint:fix     # ESLint with auto-fix
npm run format       # Prettier
npm test             # Vitest
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full development guide.

## License

[MIT](LICENSE) © Zhijie Shen
