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
| **Lightweight (zero config)** | ✅ | ✅ | ✅ | ⚠️ Git required |

## Frequently Asked Questions (FAQ)

**What is the best open-source alternative to Claude Code?**
OpenCLI is designed as an open-source, model-agnostic alternative to Claude Code. It supports the same Agent Skills standard and provides a similar seamless terminal experience, but allows you to use Claude, Gemini, or OpenAI models.

**How do I run Gemini or Claude in the terminal?**
Install OpenCLI via `npm install -g @zjshen/opencli`, set your `GEMINI_API_KEY` or `ANTHROPIC_API_KEY`, and run the `opencli` command. You can switch models easily using `opencli config --model <model-name>`.

**How do I safely sandbox an AI coding agent?**
OpenCLI automatically sandboxes its bash execution environment by default. On macOS, it uses `sandbox-exec`, and on Linux, it uses `bwrap`. This ensures the AI cannot accidentally destroy your system or access unauthorized files outside your project.

**Does OpenCLI support the Model Context Protocol (MCP)?**
Yes, OpenCLI fully supports MCP servers. You can configure them using `opencli mcp add` to grant the agent secure access to local databases, GitHub issues, and other external tools.

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

**Built-in commands:** `/help`, `/plan <task>`, `/rewind`, `/clear`, `/exit`

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
| `OPENCLI_SNAPSHOT` | Set to `off` to disable git snapshot/rewind |

## Sandbox Isolation

The `bash` tool runs inside an OS-level sandbox by default (`--sandbox auto`):

- **macOS** — uses `sandbox-exec` (built-in, no install required). Writes outside common dev locations are denied; reads and network are unrestricted.
- **Linux** — uses `bwrap` (bubblewrap) via user namespaces. Same contract. Falls back to passthrough with a warning if `bwrap` is not installed.
- **Windows / other** — no native sandbox; runs without isolation with a warning.

| Mode | Behaviour |
|------|-----------|
| `auto` (default) | Prevents accidental writes to system & credential paths (`/etc`, `~/.ssh`, `~/.aws`, etc.). Reads and network unrestricted. Writes allowed inside CWD, `/tmp`, and common dev dirs (`~/.npm`, `~/.cache`, `~/.cargo`, `~/Library/Caches`, …). **Not a security boundary** — use `strict` for real isolation. |
| `strict` | Real isolation: no external network, writes only to CWD + tmp, reads restricted to CWD + system binaries. **Currently stubbed — falls back to `auto` with a warning.** Tracked in [#149](https://github.com/zjshen14/opencli/issues/149). |
| `off` | No sandbox |

> **⚠ Behavior change (May 2026):** Prior to this release, `--sandbox auto` denied all external network access. As of [#127](https://github.com/zjshen14/opencli/issues/127), `auto` allows external network by default — every real coding workflow (`npm install`, `gh`, `git clone`, `curl`) was blocked otherwise. If you relied on the previous network-deny behavior, use `--sandbox strict` (once [#149](https://github.com/zjshen14/opencli/issues/149) lands) or `--sandbox off` plus an external firewall.

```bash
# CLI flag
opencli chat --sandbox off

# Environment variable
OPENCLI_SANDBOX=off opencli chat

# Config file
opencli config  # shows current config
```

## Snapshot & rewind

Before the agent writes any file, OpenCLI automatically takes a git snapshot of the current working tree. If the agent makes changes you want to undo, run `/rewind` in the REPL to restore all files to their pre-write state.

```
/rewind    # restore working tree to the state before this session's writes
```

- Requires git ≥ 2.23 and a git repository in the project directory.
- Only tracked files are covered; **untracked files created by the agent are not removed** by `/rewind` (use `git clean -f` manually for those).
- Staged changes (index) are not touched — only the working tree is restored.
- Set `OPENCLI_SNAPSHOT=off` to disable the feature entirely.

## MCP servers

OpenCLI can connect to any [Model Context Protocol](https://modelcontextprotocol.io) server and expose its tools to the agent as `mcp__<server>__<tool>`.

### Managing servers

```bash
opencli mcp add                            # interactive wizard
opencli mcp add myserver npx -y @myco/mcp-server  # one-shot (stdio)
opencli mcp add api --transport http --url http://localhost:3000/mcp  # HTTP
opencli mcp list                           # list configured servers with live status
opencli mcp test myserver                  # probe connection and list tools
opencli mcp remove myserver                # remove a server
```

### Configuration format (`~/.opencli/mcp.json`)

```json
{
  "mcpServers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "callTimeout": 30000
    },
    "api": {
      "transport": "http",
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer ${API_TOKEN}" }
    }
  }
}
```

- **`${VAR}`** in `command`, `args`, `url`, and `headers` is expanded from environment variables at startup. Unset variables expand to `""` with a warning.
- **`callTimeout`** (milliseconds, per-server) overrides the global default of 60 000 ms.
- Tool names are prefixed as `mcp__<server>__<tool>`. Non-alphanumeric characters in server names (except `-`) are replaced with `_`.
- All MCP tool calls require HITL confirmation. The confirmation dialog offers extra choices: allow this tool with any args (`t`), or allow all tools from this server (`s`).

### In-session management

```
/mcp              # list configured servers
/mcp test <name>  # probe a server inline
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
