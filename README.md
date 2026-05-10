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

**Built-in commands:** `/help`, `/plan <task>`, `/rewind`, `/clear`, `/exit`

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
| `OPENCLI_SNAPSHOT` | Set to `off` to disable git snapshot/rewind |

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
