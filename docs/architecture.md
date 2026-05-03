# Architecture Design - OpenCLI

## Overview

A general-purpose AI agent CLI that supports Google Gemini and Anthropic Claude models, similar to Claude Code and Gemini CLI. The agent can assist with software development tasks through natural language interaction with tool execution capabilities.

## Design Principles

1. **Developer-First UX**: Fast, intuitive command-line interface with streaming responses
2. **Safety**: Confirmations for dangerous operations, sandboxed execution where possible
3. **Extensibility**: Plugin architecture for custom tools and capabilities
4. **Performance**: Efficient context management, parallel tool execution
5. **Simplicity**: Start simple, add complexity only when needed
6. **Stay at the Frontier**: This is an exploratory project — always use the latest GenAI and agent models, preview models are acceptable

## High-Level Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                         CLI Layer                            │
│  - Command parsing                                           │
│  - Terminal UI (prompts, markdown rendering)                 │
│  - User interaction (questions, confirmations)               │
│  - Skill invocation (/slash commands, preprocessing)         │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                     Agent Core                               │
│  - Main agent loop (request → LLM → tools → response)       │
│  - Conversation state management                             │
│  - Context window management                                 │
│  - Streaming handler                                         │
│  - Skill catalog injection + activation dispatch             │
└──────────────────────┬──────────────────────────────────────┘
                       │
        ┌──────────────┼──────────────┬──────────────┐
        │              │              │              │
┌───────▼──────┐ ┌────▼────────┐ ┌──▼──────────┐ ┌▼─────────────┐
│ Model Layer  │ │ Tool System │ │ State Mgmt  │ │ Skill System │
│              │ │             │ │             │ │              │
│ - LLMClient  │ │ - File ops  │ │ - Session   │ │ - Registry   │
│   interface  │ │ - Bash exec │ │ - History   │ │ - SKILL.md   │
│ - Gemini     │ │ - Search    │ │ - Config    │ │   loader     │
│ - Anthropic  │ │             │ │ - Cache     │ │ - Built-ins  │
│ - Factory    │ │             │ │             │ │              │
└──────────────┘ └─────────────┘ └─────────────┘ └──────────────┘
```

## Core Components

### 1. CLI Layer

**Responsibilities:**
- Parse command-line arguments and flags
- Initialize and manage terminal UI
- Handle user input/output
- Render markdown and code syntax highlighting
- Display progress indicators

**Tech Stack:**
- `commander` — CLI argument parsing
- `marked` + `marked-terminal` — Markdown rendering (`MarkdownStreamRenderer` buffers to paragraph boundaries before rendering)
- Raw Node.js `readline` — per-keystroke input, slash-command popup

**Built-in slash commands:**
- `/plan <task>` — read-only planning pass → `@clack/prompts` approval → react-mode execution
- `/help`, `/clear`, `/exit` — REPL housekeeping

**Skill Invocation (CLI Layer responsibilities):**
- Intercept input starting with `/` before forwarding to Agent Core
- Parse `/<skill-name> [args]`, look up skill in registry
- Run `!{cmd}` shell preprocessors and substitute `$ARGUMENTS`
- Inject the resulting content into Agent Core as a context event
- Provide tab-completion for skill names

**Key Files:**
```
src/cli/
  ├── index.ts           # CLI entry point (chat / run / sessions / config commands)
  ├── repl.ts            # Interactive REPL + session logging
  ├── renderer.ts        # MarkdownStreamRenderer, tool call display
  └── input.ts           # Raw-mode input, slash-command popup
```

### 2. Agent Core

**Responsibilities:**
- Main agent loop: user input → LLM → tool execution → response
- Manage conversation context and history
- Handle streaming responses from the active LLM provider
- Coordinate tool execution (parallel/sequential)
- Error handling and recovery

**Agent Loop Flow:**
```
1. User Input  (+ optional mode: "react" | "plan")
   ↓
2. Build Context (history + tool results + system prompt)
   In plan mode: filter tool list to read/glob/grep/think only
                 append PLAN_SYSTEM_SUFFIX to system instruction
   ↓
3. Call LLM provider (via LLMClient interface)
   ↓
4. Stream Response
   ├─→ Text chunks → Display to user
   └─→ Function calls → Execute tools
       ↓
5. If function calls:
   ├─→ Execute tools (parallel, Promise.all)
   │    In plan mode: write/edit/bash blocked at executor level (readOnly guard)
   │    For each call: check requiresConfirmation → invoke ConfirmFn if needed → deny or proceed
   ├─→ Append event-driven reminders to last tool result
   │    e.g. after edit/write → "run tests after making code changes"
   ├─→ Collect results
   └─→ Feed back to LLM (goto step 2)

6. Safety guards (checked each turn):
   ├─→ Max-turns exceeded (default 50) → emit error event, stop
   └─→ Stuck-loop: 3+ identical call signatures in a row → emit error event, stop

7. If final response (no function calls):
   └─→ Display to user
```

**Plan mode** (`/plan <task>` in REPL, `--plan` flag on `opencli run`):
- Runs a read-only exploration pass with `Agent.run(input, "plan")`
- Tool definitions filtered to `read/glob/grep/think/activate_skill`; executor additionally enforces `readOnly` as defence-in-depth
- System prompt extended with a structured plan template (4-step process: Understand → Explore → Design → Plan; mandatory checklist output with file paths and ⚠️ risk flagging)
- REPL shows a `@clack/prompts` select (Approve & execute / Edit in $EDITOR / Cancel) after the plan is generated
- On approval: plan injected as a synthetic user message, agent switches to `"react"` mode for execution

**Skill responsibilities in Agent Core:**
- At session start: `SkillRegistry.discover()` is called; the catalog (name + description, ~50–100 tokens/skill) is injected into the system prompt via `{SKILL_CATALOG}` so the model can self-activate skills via `activate_skill`
- On user-explicit activation (`/skill-name`): receive pre-processed skill content from CLI Layer, inject into conversation context as a system event
- On model-driven activation: handle `activate_skill` function calls from the LLM, load and inject the full `SKILL.md` body as a tool result
- Protect activated skill content from context pruning (tag with `<skill_content name="...">`)
- Deduplicate: skip re-injection if a skill is already active in the session

**Key Files:**
```
src/agent/
  ├── core.ts            # Main agent loop; AgentRunMode type; plan-mode tool filtering + prompt suffix
  ├── context.ts         # Context management, ContextManager class
  ├── executor.ts        # Tool execution; middle-truncation (bash/grep/glob >20k); readOnly guard; HITL confirmation gate (ConfirmFn)
  └── prompt.ts          # DEFAULT_SYSTEM_INSTRUCTION; AGENT_REMINDERS (event-driven); getGitContext()
```

### 3. Model Layer (LLM Provider Abstraction)

**Responsibilities:**
- Provider-agnostic `LLMClient` interface consumed by Agent Core
- Per-provider clients (`GeminiClient`, `AnthropicClient`) that translate internal types to wire formats
- Generic tool definition schema (`ToolDefinition`) in plain JSONSchema — no provider dependencies
- Provider selection via `createClient()` factory based on model name
- Streaming support and exponential-backoff retries, per provider
- API key resolution per provider

**Provider selection:**

`createClient(model, config)` in `factory.ts` detects the provider by model name prefix:
- `claude-*` → `AnthropicClient` (reads `ANTHROPIC_API_KEY` / `config.anthropicApiKey`)
- anything else → `GeminiClient` (reads `GEMINI_API_KEY` / `config.geminiApiKey`)

**Tool definitions vs tool execution:**

`schema.ts` converts `Tool` objects to `ToolDefinition` (provider-agnostic, plain JSONSchema). Each client translates `ToolDefinition[]` into its own wire format internally:

```typescript
// Tool System: implementation (src/tools/file/read.ts)
const readTool: Tool = {
  name: "read",
  description: "Read file contents",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string" },
      offset:    { type: "number" }
    },
    required: ["file_path"]
  },
  execute: async ({ file_path }) => { ... }
};

// schema.ts → ToolDefinition (passed to LLMClient.stream)
{ name: "read", description: "Read file contents", parameters: { type: "object", ... } }

// GeminiClient translates internally: type → uppercase, wraps in functionDeclarations
// AnthropicClient translates internally: used directly as input_schema (JSONSchema compatible)
```

The `activate_skill` definition is expressed the same way:

```typescript
// src/model/schema.ts
export const activateSkillDefinition: ToolDefinition = {
  name: "activate_skill",
  description: "Activate a skill to load its instructions into context",
  parameters: {
    type: "object",
    properties: { name: { type: "string", description: "Skill name to activate" } },
    required: ["name"]
  }
};
```

**Provider-specific notes:**

- **Gemini**: types uppercased (`"object"` → `"OBJECT"`); `thoughtSignature` threaded through thinking model calls; uses `functionCall`/`functionResponse` message parts.
- **Anthropic**: `role: "model"` translated to `"assistant"`; tool calls use `tool_use`/`tool_result` content blocks; `thoughtSignature` ignored.

The Tool System owns execution and knows nothing about any provider SDK. Swapping or adding a provider requires only adding a new client in `src/model/` and a branch in `factory.ts`.

**Key Files:**
```
src/model/
  ├── client.ts          # LLMClient interface — the provider plug point
  ├── gemini.ts          # GeminiClient: Gemini wire format, thoughtSignature, backoff
  ├── anthropic.ts       # AnthropicClient: Anthropic wire format, tool_use blocks, backoff
  ├── factory.ts         # createClient() — provider detection + key resolution
  ├── schema.ts          # toolToDefinition() + activateSkillDefinition (generic JSONSchema)
  └── types.ts           # Shared types: Message, StreamEvent, ToolDefinition, thoughtSignature
```

### 4. Tool System

**Tool Categories:**

**File Operations:**
- `read` — Read file contents (with offset/limit support; output never truncated — agents rely on exact line spans for follow-up edits)
- `write` — Write/create files
- `edit` — Edit files (exact old_string → new_string; fails if match is ambiguous)
- `glob` — Find files by pattern
- `grep` — Search file contents with regex

**Execution:**
- `bash` — Execute shell commands. Commands not in the `SAFE_COMMANDS` allowlist require user confirmation via the HITL gate before running.

**Reasoning:**
- `think` — Private scratchpad for multi-step reasoning; output suppressed in the REPL UI. Omitted from the registry when the active model has native thinking (e.g. Gemini 2.5+/3.x) to avoid double-paying for reasoning.

**Output truncation:** `bash`, `grep`, and `glob` results exceeding `OPENCLI_MAX_TOOL_OUTPUT` (default 20 000 chars) are middle-truncated: 30% head + 70% tail, with the full output saved to `{SESSION_TMP}/tool-output-{id}.txt` when a session tmp directory is set.

**Tool Interface:**
```typescript
interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  execute: (params: unknown) => Promise<ToolResult>;
  /** Return true to require interactive user confirmation before execution. */
  requiresConfirmation?: (args: Record<string, unknown>) => boolean;
}

interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}
```

**Key Files:**
```
src/tools/
  ├── registry.ts        # Tool registration and lookup
  ├── base.ts            # Tool interface + JSONSchema type
  ├── index.ts           # createDefaultRegistry(model?) — omits think for native-thinking models
  ├── think.ts           # think tool (private scratchpad)
  ├── file/              # read, write, edit, glob, grep
  └── exec/              # bash
```

### 5. Skill System

Skills are prompt-level capabilities — packaged `SKILL.md` instructions that get injected into the agent's context. Unlike tools (which execute code), skills deliver Markdown instructions for the model to follow using existing tools.

**Standard:** Aligned with the [Agent Skills open standard](https://agentskills.io), which is adopted by Claude Code, the official Gemini CLI, Cursor, GitHub Copilot, and others. This enables skill sharing across the ecosystem.

**Skill format** (`SKILL.md`):
```yaml
---
name: review                        # becomes /review slash command
description: Review code for correctness, style, and security issues.
                                    # model uses this to auto-activate
allowed-tools: Read Grep            # pre-approved, no confirmation needed
disable-agent-invocation: true      # true = user-only (e.g. deploy, commit)
---

Review the following code: $ARGUMENTS

Check for:
- Correctness and logic errors
- Security vulnerabilities
- Code style

Current branch info:
!{git log --oneline -5}             # shell preprocessing — output injected before sending to model
```

**Directory structure (scoped, earlier takes precedence):**
```
~/.opencli/skills/<name>/SKILL.md      # user-global
<project>/.opencli/skills/<name>/SKILL.md  # project-scoped
<project>/.agents/skills/<name>/SKILL.md    # cross-client convention (agentskills.io)
```

**Three-tier loading (progressive disclosure):**

| Tier | Content | When loaded | Token cost |
|------|---------|-------------|------------|
| 1. Catalog | name + description only | Session start | ~50–100/skill |
| 2. Instructions | Full `SKILL.md` body | On activation | <5000 recommended |
| 3. Resources | Scripts, reference files | When referenced | On demand |

**Invocation paths:**
1. **User-explicit**: `/review src/auth.ts` — CLI Layer intercepts, preprocesses, injects
2. **Model-driven**: Gemini calls `activate_skill("review")` when it matches the catalog description — Agent Core loads and injects

**Built-in skills** (shipped with the CLI):

_Core workflow_
- `/commit` — Draft and create a git commit (user-only, `disable-agent-invocation: true`)
- `/gh-issue` — Create, view, list, and comment on GitHub issues via `gh` CLI
- `/gh-pr` — Open, review, check CI, and merge GitHub PRs via `gh` CLI
- `/branch` — Create feature branches tied to GitHub issue numbers

_Code quality_
- `/review` — Code review for correctness, style, security
- `/debug` — Diagnose and fix a reported error
- `/run-tests` — Detect test framework, run suite, surface failures
- `/typecheck` — Run `tsc`/`mypy` and report type errors grouped by file
- `/lint` — Run linter with optional auto-fix

_Comprehension_
- `/explain` — Explain selected code or a concept
- `/test` — Write tests for a given function or module

_Skill authoring_
- `/new-skill` — Scaffold a new custom SKILL.md interactively (user-only)

**Key Files:**
```
src/skills/
  ├── registry.ts        # Discover, parse, and catalog SKILL.md files; catalogSummary() → {SKILL_CATALOG}
  ├── loader.ts          # Load skill body, run !{} preprocessors, substitute $ARGUMENTS
  └── builtin/           # Built-in skill SKILL.md files
      ├── commit/
      ├── gh-issue/
      ├── gh-pr/
      ├── branch/
      ├── review/
      ├── debug/
      ├── run-tests/
      ├── typecheck/
      ├── lint/
      ├── explain/
      ├── test/
      └── new-skill/
```

> See [`docs/skills.md`](skills.md) for the full authoring guide (format, preprocessors, custom skills).

### 6. State Management

**Responsibilities:**
- Session lifecycle: create, log, list, resume
- Configuration storage and API key resolution

**Session storage layout** (mirrors Claude Code's pattern — never written inside the project):
```
~/.opencli/
  config.json                                    # persisted user config
  projects/
    -Users-alice-myproject/                      # encoded cwd (/ → -)
      2025-06-01T14-23-45.jsonl                  # one JSONL file per session
      2025-06-02T09-10-00.jsonl
```

Each JSONL line is a timestamped entry: `session_start`, `user`, `assistant`, `tool_call`, `tool_result`.

**Session resume** — `Session.loadMessages(id | "latest")` reconstructs `Message[]` from the log, skipping tool call entries (text content is sufficient for context). Pass `"latest"` to resume the most recent session that has actual conversation content.

**Scratch directory** — `session.tmpDir` resolves to `<cwd>/.opencli/tmp/<session-id>/`. Agent-generated temporary files land here, scoped to the session, and never pollute the project root.

**Key Files:**
```
src/state/
  ├── session.ts         # Session: create, list, loadMessages, log, tmpDir
  └── config.ts          # Config load/save, exports AGENT_DIR and Config interface
```

## Data Flow

### Typical Interaction:

1. **User**: "Read the package.json file and update the version to 2.0.0"

2. **CLI Layer**: Parse input, send to Agent Core

3. **Agent Core**:
   - Build context with conversation history
   - Send to LLM provider (via `LLMClient`) with available tool definitions

4. **LLM Response 1** (streaming):
   ```
   Text: "I'll read the package.json file first"
   Function Call: read({ file_path: "package.json" })
   ```

5. **Tool Execution**:
   - Execute `read` tool
   - Return file contents

6. **Agent Core**: Send tool result back to LLM provider

7. **LLM Response 2**:
   ```
   Text: "I can see the current version is 1.5.0. I'll update it to 2.0.0"
   Function Call: edit({
     file_path: "package.json",
     old_string: '"version": "1.5.0"',
     new_string: '"version": "2.0.0"'
   })
   ```

8. **Tool Execution**:
   - Execute `edit` tool
   - Return success

9. **LLM Response 3**:
   ```
   Text: "Updated package.json version to 2.0.0"
   ```

10. **CLI Layer**: Display final response to user

### Skill Invocation Flow:

1. **User**: "/review src/auth.ts"

2. **CLI Layer**:
   - Detects `/` prefix, looks up "review" in SkillRegistry
   - Reads `SKILL.md` body
   - Runs `!{git log --oneline -5}` preprocessor, substitutes output
   - Substitutes `$ARGUMENTS` → "src/auth.ts"
   - Sends processed content to Agent Core as a context event

3. **Agent Core**:
   - Injects skill content into conversation context tagged as `<skill_content name="review">`
   - Continues normal agent loop with enriched context

4. **LLM provider**: Receives skill instructions + user message, uses `read` and `grep` tools to execute the review

5. **CLI Layer**: Streams and renders the review response

## Tool Execution Model

### Parallel Execution
When tools are independent (no data dependencies), execute in parallel:

```typescript
// Gemini requests: read("file1.ts"), read("file2.ts")
const results = await Promise.all([
  tools.execute("read", { file_path: "file1.ts" }),
  tools.execute("read", { file_path: "file2.ts" })
]);
```

### Sequential Execution
When tools depend on each other, execute sequentially:

```typescript
// Tool 1: read file
const content = await tools.execute("read", { file_path: "config.json" });

// Tool 2: edit based on content
const result = await tools.execute("edit", {
  file_path: "config.json",
  old_string: extracted_from_content,
  new_string: new_value
});
```

### Safety Checks
- **HITL confirmation gate** — before executing a tool call, the executor checks `tool.requiresConfirmation?.(args)`. If true, it invokes the injected `ConfirmFn`:
  - Interactive REPL: shows a `selectKey` prompt ("Yes once / Yes always this session / No"). The session allow-list is maintained as an in-memory `Set` inside the `ConfirmFn` closure.
  - Non-interactive `run` mode: auto-denies unless `--yes` is passed (which installs an auto-approve `ConfirmFn`).
- Validate file paths (prevent path traversal)
- Rate limit API calls

## Context Management

`ContextManager` (in `src/agent/context.ts`) owns all context state for a session.

**System instruction** is rendered from a template at first call and cached until tools or `sessionTmpDir` change. Placeholders `{CWD}`, `{SESSION_TMP}`, `{TOOL_CATALOG}` are substituted at render time. The tool list is embedded in the static prefix to maximise implicit prompt cache hits across turns.

**Conversation history** is a sliding window of the last 50 messages (pruned from the oldest end). Skill content is held in a separate `skillContent[]` array that is never pruned; it is prepended as a synthetic user message when `getMessages()` is called.

**Constructor injection**: `new ContextManager(template?)` accepts a custom system instruction template, making it easy to swap prompts in tests or for A/B experiments without touching files.

## Configuration

**User Configuration** (`~/.opencli/config.json`):
```json
{
  "geminiApiKey": "...",
  "anthropicApiKey": "...",
  "model": "gemini-3.1-flash-lite-preview",
  "maxTokens": 8192,
  "temperature": 0.7,
  "autoExecute": false,
  "theme": "dark",
  "historySize": 50
}
```

**Environment Variables** (take precedence over config file):
- `GEMINI_API_KEY` — Gemini API key
- `ANTHROPIC_API_KEY` — Anthropic API key
- `OPENCLI_MODEL` — Model override (beats `--model` flag and config)
- `OPENCLI_SYSTEM_MD` — Path to a Markdown file that replaces the default system instruction

## Security Considerations

1. **API Key Protection**
   - Store in config file with proper permissions
   - Never log API keys
   - Support environment variables

2. **Command Execution**
   - Warn before destructive operations
   - Sandbox execution where possible
   - Validate all inputs

3. **File Access**
   - Validate file paths
   - Prevent path traversal attacks
   - Respect .gitignore patterns

4. **Network Requests**
   - Validate URLs
   - Timeout protection
   - Rate limiting

## Performance Optimizations

1. **Streaming**: Always stream responses for better UX
2. **Parallel Tools**: Execute independent tools in parallel
3. **Caching**: Cache API responses when appropriate
4. **Lazy Loading**: Load tools on-demand
5. **Smart Context**: Only include relevant context

## Error Handling

**Strategy**:
- Graceful degradation
- User-friendly error messages
- Automatic retry with exponential backoff
- Detailed logging for debugging

**Error Categories**:
- API errors (rate limits, timeouts)
- Tool execution errors
- User input errors
- System errors

## Testing Strategy

- **Unit tests** colocated with source (`context.ts` → `context.test.ts`)
- **Real filesystem** for file tool tests (no `fs` mocking — mocks hide real bugs)
- **Mock at boundaries**: LLM clients and `SkillRegistry` are mocked; internal collaborators (`ContextManager`, `ToolRegistry`) are used directly
- **Coverage threshold**: 70% lines/statements/functions/branches via vitest v8; config files, type-only files, and `agent/core.ts` (requires live LLM) are excluded

## Deployment & Distribution

**Build**:
```bash
npm run build   # bundles with tsup → dist/
```

**Run locally**:
```bash
npm run dev               # interactive REPL (auto-loads .env)
npm run dev run "<prompt>" # one-shot
```

## References

- [Gemini API Documentation](https://ai.google.dev/docs)
- [Claude Code Architecture](https://github.com/anthropics/claude-code)
- [Function Calling Guide](https://ai.google.dev/docs/function_calling)
- [Agent Skills Open Standard](https://agentskills.io/specification)
- [Agent Skills Client Implementation Guide](https://agentskills.io/client-implementation/adding-skills-support)
