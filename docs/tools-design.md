# Tools Design

This document describes the tool system architecture, the design rationale for each built-in tool, and guidelines for adding new tools.

---

## Architecture

Tools are the mechanism by which the LLM interacts with the outside world. Every tool implements the `Tool` interface (`src/tools/base.ts`):

```typescript
interface Tool {
  name: string;
  description: string;        // what the model reads to decide when to call it
  parameters: JSONSchema;     // input schema
  execute: (params: Record<string, unknown>) => Promise<ToolResult>;
}
```

All tools return `{ success: boolean; output: string; error?: string }`.

### Data flow

```
Agent.run()
  → allToolDefs = registry.all().map(toolToDefinition)
  → LLMClient.stream(messages, systemInstruction, toolDefs)
  → model emits function_call events
  → executeCalls() in executor.ts runs all calls in parallel
  → results fed back as user message → next LLM turn
```

### Key invariants

- **Provider-agnostic.** Tools have no knowledge of which LLM provider is in use. `schema.ts` converts `Tool` objects to generic `ToolDefinition` (plain JSONSchema); each provider client translates these to its own wire format.
- **No circular imports.** `tools/` never imports from `agent/` or `model/`.
- **All tools return strings.** The `output` field is always a string fed back to the model as a `function_result`. Structured data (JSON, line-numbered text) is serialised to string before return.
- **Output truncation.** `bash`, `grep`, and `glob` outputs are middle-truncated at `OPENCLI_MAX_TOOL_OUTPUT` chars (default 20,000). `read` is exempt — agents rely on exact line spans for follow-up edits.

### Plan mode

When `Agent.run(input, "plan")` is called, only read-only tools are exposed. The allowed set is `PLAN_MODE_TOOLS` in `core.ts`. Write tools are blocked at two layers:
1. Filtered from the tool definitions sent to the LLM
2. Refused by the executor (`WRITE_TOOLS` set in `executor.ts`) as defence-in-depth

### Renderer display

Tools fall into two display categories in the CLI:

- **Compact** (`COMPACT_TOOLS` in `renderer.ts`): rendered as a single dim line. Used for fast, read-only tools with low visual noise: `read`, `glob`, `grep`, `ls`, `think`, `todo_read`, `todo_write`.
- **Full box**: rendered as a bordered box with the tool name, arguments, and a result line. Used for write/exec tools: `write`, `edit`, `bash`, `web_fetch`.

---

## Built-in tools

### File tools (`src/tools/file/`)

#### `read`
Read file contents with line numbers (`cat -n` style). Supports `offset` (1-based start line) and `limit` (max lines) for reading large files in chunks. Line numbers are included so the model can pass them back to `edit`.

**When to use:** reading any file. Use `offset`/`limit` for large files once you know the relevant line range (e.g. after `list_code_definitions`).

**Plan mode:** ✅ allowed

#### `write`
Create or overwrite a file entirely. Requires `file_path` and `content`.

**When to use:** creating new files, or rewriting a file completely. Prefer `edit` for targeted changes.

**Plan mode:** ❌ blocked

#### `edit`
Exact `old_string → new_string` replacement. The `old_string` must appear **exactly once** in the file — fails with a clear error if ambiguous or not found.

**When to use:** surgical changes to existing files. The uniqueness requirement prevents unintended edits.

**Plan mode:** ❌ blocked

#### `glob`
Find files by glob pattern (`**/*.ts`, `src/**/*.test.ts`). Returns matching paths sorted by modification time (newest first). Skips `node_modules` and hidden directories.

**When to use:** finding files by name/extension pattern. Use `grep` when you need to search by content.

**Plan mode:** ✅ allowed

#### `grep`
Regex search across file contents. Returns matching lines with file path and line number.

**When to use:** finding where a symbol is used, searching for a string across the codebase.

**Plan mode:** ✅ allowed

#### `ls`
List directory contents with file type and size. Directories are listed first, then files alphabetically. Files include byte size.

**When to use:** exploring a directory structure. Prefer over `bash ls` — no shell spawn, no dangerous-command guard, returns structured output. Use `glob` when you need pattern matching.

**Plan mode:** ✅ allowed

### Exec tools (`src/tools/exec/`)

#### `bash`
Execute a shell command. Dangerous patterns (`rm -rf`, `git push --force`, etc.) are blocked at the tool level. Output is truncated at `OPENCLI_MAX_TOOL_OUTPUT`.

**When to use:** running tests, builds, git commands, package managers, or anything requiring a real shell. All other file tools are preferred over `bash` for file operations.

**Plan mode:** ❌ blocked (reliably validating bash as read-only is not feasible)

### Web tools (`src/tools/web/`)

#### `web_fetch`
Fetch a URL and return its content as plain text. HTML is converted to readable text (style/script blocks removed, tags stripped, entities decoded). Response is truncated to `OPENCLI_MAX_TOOL_OUTPUT`.

**When to use:** reading documentation, GitHub issues, API references, or any URL the user shares. Does not support arbitrary curl flags — the URL is the only input.

**Plan mode:** ✅ allowed (read-only)

### Task tools (`src/tools/task/`)

#### `todo_write`
Write the session task list. Replaces the entire list on every call. Each item has `id`, `text`, and `status` (`pending` / `in_progress` / `done`). Stored in a pid-keyed temp file for the lifetime of the process (= one CLI session).

**When to use:** multi-step tasks — write the plan as todos at the start, update status as each step completes. Pairs naturally with `/plan` mode.

**Plan mode:** ❌ blocked (mutates state)

#### `todo_read`
Read the current session task list written by `todo_write`. Returns a formatted list with status icons: `[ ]` pending, `[~]` in_progress, `[x]` done.

**When to use:** checking progress before continuing a multi-step task, or after a session resume.

**Plan mode:** ✅ allowed

### Think tool (`src/tools/think.ts`)

#### `think`
A private scratchpad. The model writes reasoning text; no side effects. Output is never shown to the user. Omitted for models with native thinking/reasoning (Gemini 2.5+, any model where `hasNativeThinking()` returns true) since their built-in reasoning is cheaper.

**When to use:** working through a complex problem before taking action.

**Plan mode:** ✅ allowed

---

## Provider-native tools (not in ToolRegistry)

Some capabilities are implemented server-side by the LLM provider and cannot be expressed as a `Tool` — there is no `function_call` for the executor to handle.

### Web search

Each provider that supports native search requires its own declaration injected at the provider client level:

| Provider | Declaration |
|---|---|
| Anthropic | `{ type: "web_search_20250305" }` in `tools[]` |
| Gemini | `{ googleSearch: {} }` in `tools[]` |
| Kimi | `{ type: "builtin_function", function: { name: "$web_search" } }` |
| Qwen | `enable_search: true` via `extra_body` |
| Grok | `{ type: "web_search" }` in Responses API |

Providers without native search (OpenAI standard models, DeepSeek, Gemma) require a client-side fallback tool using a third-party search API. See `docs/tool-gaps-research.md` and issue #37.

---

## Adding a new tool

1. **Create the tool file** — colocate at `src/tools/<category>/<name>.ts`. Export a named `const` implementing `Tool`.
2. **Write a test** — colocate at `src/tools/<category>/<name>.test.ts`. Use a real `tmpdir` for filesystem tools; mock `fetch` / external services at the boundary.
3. **Register in `src/tools/index.ts`** — add to the export list and to the `tools` array in `createDefaultRegistry`.
4. **Plan mode** — decide if the tool is read-only. If yes, add its name to `PLAN_MODE_TOOLS` in `src/agent/core.ts`. If it mutates state, add it to `WRITE_TOOLS` in `src/agent/executor.ts`.
5. **Renderer** — decide if it should render as compact or full-box. Add to `COMPACT_TOOLS` in `src/cli/renderer.ts` if it's a fast read-only tool.
6. **Tool description** — the description is what the model reads to decide *when* to call the tool. It should state: what the tool does, what it returns, and when to prefer it over alternatives (e.g. "use `ls` for directory listing; use `glob` when you need pattern matching").

---

## Planned tools

| Tool | Issue | Status | Notes |
|---|---|---|---|
| `list_code_definitions` | #27 Phase 2 | Planned | Regex over `export (function\|class\|const\|type\|interface)`; upgrade to tree-sitter later |
| `web_search` (native) | #37 | Planned | Provider-native per-client injection; fallback to Brave/Tavily for unsupported providers |
| LSP tools | #27 future | Future | Full LSP client — `documentSymbol`, `goToDefinition`, `findReferences`; matches Claude Code depth |
| `browser_action` | #27 out of scope | Deferred | Playwright; too heavy for terminal CLI |
