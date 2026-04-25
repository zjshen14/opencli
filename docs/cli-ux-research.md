# CLI UX Research: Gemini CLI vs Claude Code

Research into the interactive CLI experience of Google's Gemini CLI and Anthropic's Claude Code, to inform the roadmap for improving this project's REPL.

---

## Current State of This Project

The current CLI (`src/cli/`) is a minimal readline REPL:
- Single-line input via Node's `readline/promises`
- No input history persistence across sessions
- No multiline input
- No spinner — streaming output starts with no loading feedback
- Tool results truncated to 80–120 chars, no diff rendering for edits
- 4 slash commands: `/help`, `/clear`, `/exit`, `/quit`

---

## Feature Comparison

### Input Handling

| Feature | Gemini CLI | Claude Code | This project |
|---|---|---|---|
| History (Up/Down) | ✓ per-session + reverse search | ✓ per-working-directory, persisted | Ephemeral (session only) |
| Multiline input | `\`+Enter, Ctrl+Enter, Shift+Enter, external `$EDITOR` | `\`+Enter, Option+Enter, Shift+Enter, Ctrl+G for editor | ✗ |
| Vim mode | ✓ full NORMAL/INSERT with text objects | ✓ via `/config` | ✗ |
| `@file` mention | ✓ with autocomplete | ✓ with fuzzy autocomplete | ✗ |
| `!cmd` bash mode | ✓ | ✓ | ✗ |
| Image paste | ✗ | ✓ clipboard → multimodal chip | ✗ |
| Voice input | ✗ | ✓ push-to-talk (Space hold) | ✗ |
| AI prompt suggestions | ✗ | ✓ grayed-out; Tab to accept | ✗ |

### Output Rendering

| Feature | Gemini CLI | Claude Code | This project |
|---|---|---|---|
| Markdown rendering | ✓ full, with syntax highlighting | ✓ full, with syntax highlighting | ✓ via marked-terminal |
| Themes | 10 dark + light variants + no-color | Fewer, + colorblind (daltonized) + ANSI | ✗ |
| Spinner | Animated rainbow gradient (Google brand colors) | Animated dots | ✗ (ora installed but unused) |
| Thinking display | Left-bordered indented block | Collapsible element | ✗ |
| Streaming markdown | ✓ incremental | ✓ incremental | Raw text streamed, re-rendered at end |
| Inline diff for edits | ✓ colored +/- DiffRenderer | ✓ | ✗ (truncated string) |
| Tool compact mode | ✓ read/glob/grep/edit collapse to one-liners | MCP read/search collapse to one-liners | ✗ (all truncated to 80–120 chars) |
| PR status in footer | ✗ | ✓ color-coded, updates every 60s | ✗ |

### Tool Call Display

| Feature | Gemini CLI | Claude Code | This project |
|---|---|---|---|
| Spinner per tool | ✓ with check/X on done | ✓ | ✗ |
| Inline diff for edits | ✓ | ✓ | ✗ |
| Interactive PTY for shell | ✓ (Ctrl+B to focus) | ✗ | ✗ |
| Approval prompt | ✓ y/n/edit/diff dialog | ✓ y/n/always/never dialog | ✗ |
| Sticky tool headers | ✗ | ✓ pins while output scrolls | ✗ |

### Slash Commands

**Gemini CLI** (~25 commands): `/clear`, `/rewind`, `/restore`, `/compress`, `/memory`, `/init`, `/settings`, `/theme`, `/model`, `/vim`, `/tools`, `/mcp`, `/auth`, `/permissions`, `/hooks`, `/stats`, `/plan`, `/bug`, `/upgrade`, `/terminal-setup`, `/help`, `/quit`

**Claude Code** (~60+ commands): all of the above plus `/compact [instructions]`, `/resume`, `/branch` (fork session), `/context` (token usage grid), `/cost`, `/usage`, `/rewind` (granular: code/conversation/both), `/doctor`, `/export`, `/diff`, `/config`, `/statusline`, `/tasks`, `/sandbox`, `/login`, `/schedule`, and integration commands (`/ide`, `/chrome`, `/slack`, `/mobile`)

**This project** (4 commands): `/help`, `/clear`, `/exit`, `/quit`

### Session Management

| Feature | Gemini CLI | Claude Code | This project |
|---|---|---|---|
| Persist sessions | ✓ `~/.gemini/history/<project_hash>` | ✓ `~/.claude/projects/` (30-day TTL) | ✗ |
| Resume session | ✓ `/chat resume` | ✓ `claude -c`, `claude -r <name>`, `/resume` | ✗ |
| Named sessions | ✗ | ✓ `-n`/`--name` flag | ✗ |
| Session branching | ✗ | ✓ `/branch` | ✗ |
| Checkpoint/rewind | ✓ Git snapshot before every file tool | ✓ `/rewind` with code/conversation granularity | ✗ |
| Context compaction | ✓ `/compress` (auto at 50% threshold) | ✓ `/compact [instructions]` (auto-compact option) | ✗ |
| Auto memory | ✗ | ✓ Claude writes notes to `~/.claude/projects/<project>/memory/` | ✗ |

### Error Handling

| Feature | Gemini CLI | Claude Code | This project |
|---|---|---|---|
| Loop detection | ✓ dialog interrupts | ✓ dialog interrupts | ✗ |
| Env var redaction | ✓ TOKEN/SECRET/KEY patterns | ✗ | ✗ |
| `/restore` from bad tool | ✓ via Git snapshot | ✓ via `/rewind` | ✗ |
| `/doctor` health check | ✗ | ✓ | ✗ |
| Rate limit UX | Quota bar in footer | Toast + `/usage` + budget cap | Exponential backoff only (silent) |
| Protected paths | ✗ | ✓ `.git`, shell rcs always prompt | ✗ |

---

## Implementation Roadmap

### Tier 1 — High impact, achievable within current readline stack

1. **Spinner during model response** — `ora` is already a dependency; show "Thinking…" while waiting for the first token, stop on first chunk
2. **Persistent input history** — write readline history to `~/.opencli/history`; Up/Down across sessions
3. **Inline diff for `edit` tool results** — render colored `+`/`-` lines instead of truncated string
4. **Tool compact mode** — `read`/`glob`/`grep` collapse to `← read: path/to/file (42 lines)` one-liners
5. **`/compact` command** — summarize conversation history with a model call; reduces token usage for long sessions
6. **Multiline input** — `\`+Enter continuation (accumulate lines until bare Enter)

### Tier 2 — Medium impact, meaningful differentiation

7. **Session persistence + `/resume`** — serialize conversation to `~/.opencli/sessions/<project_hash>.json`; resume with `--continue` flag or `/resume`
8. **`/context` command** — display token count estimate, context window %, suggestion to `/compact`
9. **`@file` mentions** — parse `@path` in user prompt, auto-read and inline content before sending
10. **`/rewind`** — pop last turn from history; simple version (no Git snapshot needed)
11. **Rate limit feedback** — surface 429 errors with a user-friendly message and countdown

### Tier 3 — Nice to have, higher complexity

12. Named themes + `/theme` picker (highlight.js integration)
13. Vim mode (requires switching from readline to a full terminal UI library like Ink)
14. AI-generated next-prompt suggestions
15. Image paste → multimodal Gemini input (clipboard API + Gemini vision)

---

## Key Design Decisions from Both CLIs

- **Gemini CLI**: takes Git snapshots before every file-modifying tool call as the recovery mechanism. Simple and reliable without needing a database.
- **Claude Code**: re-injects CLAUDE.md fresh from disk after every `/compact` — ensures project instructions are never lost after summarization.
- **Both**: treat `src/cli/` as a display/input layer only; all agent logic is decoupled. This project already follows this pattern.
- **Both**: support `!cmd` bash passthrough at the prompt level (separate from the `bash` tool) for quick shell commands without involving the agent.
