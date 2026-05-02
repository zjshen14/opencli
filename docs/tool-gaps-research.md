# Tool Gaps Research

Research findings on what tools frontier coding agents have, how they handle code navigation and web search, and what OpenCLI should implement. Informs issues #27 and #37.

---

## Web Search

### How each provider implements native search

Provider-native search is **server-side** — the provider resolves the search before the response reaches the client. There is no `function_call` for the executor to handle. It must be injected at the provider client level, not through `ToolRegistry`.

| Provider | Native Search? | Declaration | Models | Caveats |
|---|---|---|---|---|
| **Anthropic** | ✅ | `{ type: "web_search_20250305" }` in `tools[]` | Claude 3.5+ | No extra key |
| **Gemini** | ✅ | `{ googleSearch: {} }` in `tools[]` | Gemini 1.5/2.x+ | May require billing enabled |
| **OpenAI** | ⚠️ partial | Responses API: `{ type: "web_search" }`; Chat Completions: dedicated search models only | `gpt-4.1`, `gpt-5-search-api` | Standard `gpt-4o`/`o1`/`o3`/`o4` in Chat Completions get **no** native search |
| **Kimi (Moonshot)** | ✅ | `{ type: "builtin_function", function: { name: "$web_search" } }` | `kimi-k2.6`+ | $0.005/call; thinking mode must be disabled |
| **Qwen (Alibaba)** | ✅ | `enable_search: true` via `extra_body`, or Responses API `{ type: "web_search" }` | `qwen3-max`, `qwen3.5-*` | 1000 free calls/day on DashScope |
| **Grok (xAI)** | ✅ | `{ type: "web_search" }` in Responses API | `grok-4.3`+ | Also has `x_search` for X/Twitter; Chat Completions Live Search deprecated |
| **Mistral** | ⚠️ partial | `{ type: "web_search" }` in Agents/Conversations API | `mistral-large-latest`+ | **Not** available in standard `/v1/chat/completions` |
| **DeepSeek** | ❌ | None | — | UI-only toggle; API has no built-in search |
| **Gemma** | ❌ | None | — | Open weights / local — no server to execute it |

### Design implications

- Cannot be a `ToolRegistry` tool — each provider handles it server-side with its own declaration format.
- Each provider client (`gemini.ts`, `anthropic.ts`, future `kimi.ts` etc.) must conditionally inject the provider-specific declaration, gated by a `supportsNativeSearch(model)` check similar to `hasNativeThinking(model)`.
- Three providers have no native search (OpenAI standard models, DeepSeek, Gemma). For those, a client-side `web_search` tool via a third-party API (Brave, Tavily) is the only option.
- Gemma (local open-weights) is a permanent exception — no server-side execution possible.

See issue [#37](https://github.com/zjshen14/opencli/issues/37) for the phased implementation plan.

---

## Code Navigation

### What is LSP

**Language Server Protocol (LSP)** is a Microsoft standard that separates code intelligence from the editor. A language server is a background process that understands a specific language. Any tool speaking the protocol can ask it:

- "List all symbols in this file" (`documentSymbol`)
- "Where is this symbol defined?" (`goToDefinition`)
- "Find all usages of this symbol" (`findReferences`)
- "What's the type here?" (`hover`)
- "Show the call hierarchy" (`incomingCalls` / `outgoingCalls`)

Language servers: `tsserver` (TypeScript), `gopls` (Go), `pyright` (Python), `rust-analyzer` (Rust). The agent (or editor) is just a client — it gets precise, semantically correct answers from the same engine an IDE uses, rather than relying on grep heuristics.

### How frontier agents handle code navigation

| Agent | Symbol listing | Definition lookup | Find references | Large-file strategy |
|---|---|---|---|---|
| **Claude Code** | ✅ `LSP` → `documentSymbol`, `workspaceSymbol` | ✅ `LSP` → `goToDefinition` | ✅ `LSP` → `findReferences` | LSP when active; otherwise `Grep` + `Read` with offsets |
| **Gemini CLI** | ❌ none | ❌ none | ❌ none | `grep` + shell; open feature requests #5204, #22745 |
| **Gemini Code Assist (IntelliJ)** | ✅ `find_usages` | ✅ `resolve_symbol` | ✅ `find_usages` | IntelliJ's native indexing engine |
| **Gemini Code Assist (VS Code)** | ❌ none | ❌ none | ❌ none | Same as Gemini CLI |
| **OpenAI Codex CLI** | ❌ none | ❌ none | ❌ none | Recommends `rg` (ripgrep) via `shell_command` |
| **Cline** | ✅ `list_code_definition_names` (tree-sitter) | ❌ | ❌ | tree-sitter AST parse |
| **OpenHands** | ❌ none | ❌ none | ❌ none | `IPythonRunCell` for Python introspection |

### Claude Code's LSP tool (added v2.0.74, Dec 2025)

The `LSP` tool is inactive by default and requires installing an LSP server binary. Once active it supports:

| Operation | What it does |
|---|---|
| `documentSymbol` | List all symbols in a file |
| `workspaceSymbol` | Search for classes/functions project-wide |
| `goToDefinition` | Jump to where a symbol is defined |
| `findReferences` | Find all usages across the codebase |
| `goToImplementation` | Find concrete implementations of an interface |
| `incomingCalls` / `outgoingCalls` | Trace call hierarchies |
| `hover` | Type info and documentation at a position |

It also auto-reports type errors after every `Edit` — a build-step feedback loop without running the compiler.

### Proposed implementation path for OpenCLI

**Near term — `list_code_definitions` (regex-based):**

A tool at `src/tools/file/definitions.ts` that extracts exported symbol names and line numbers using a regex over `export (function|class|const|type|interface)`. Covers ~90% of TypeScript use cases. Zero new dependencies. Plan-mode safe (read-only).

```
Agent (class) — line 76
AgentRunMode (type) — line 21
AgentEvent (type) — line 10
```

Lets the model do a targeted `read` with `offset`/`limit` instead of reading a whole large file.

**Long term — LSP client:**

Full LSP integration would match Claude Code's navigation depth. Requires:
- An LSP client library (`vscode-languageclient` or a lightweight alternative)
- Language server detection / launch logic
- Workspace indexing lifecycle management

This is a substantial effort and a meaningful differentiator. Tracked as future work under issue #27.

### Comparison: regex vs tree-sitter vs LSP

| Approach | Dependencies | Accuracy | Languages | Effort |
|---|---|---|---|---|
| Regex | None | ~90% for TS exports | Hard to extend | Low |
| tree-sitter | `tree-sitter` + grammars (~10MB) | Near-perfect | 100+ via grammars | Medium |
| LSP | Language server binary (per language) | Exact (semantic) | Any with an LSP server | High |

---

## Full tool inventory comparison

For reference, the complete tool sets of the agents researched:

### Claude Code
`Read`, `Write`, `Edit`, `MultiEdit`, `Glob`, `Grep`, `LS`, `Bash`, `NotebookRead`, `NotebookEdit`, `LSP`, `WebFetch`, `WebSearch`, `TodoWrite`, `TodoRead`

### Gemini CLI
`read_file`, `read_many_files`, `write_file`, `edit`, `glob`, `grep_search`, `list_directory`, `shell`, `web_fetch`, `google_web_search`, `save_memory`, `write_todos`

### OpenAI Codex CLI
`read_file`, `list_dir`, `glob_file_search`, `apply_patch`, `shell_command`, `write_stdin`, `update_plan`, `view_image`, `git`, `request_user_input`

### Cline
`read_file`, `write_to_file`, `apply_diff`, `search_files`, `list_files`, `list_code_definition_names`, `execute_command`, `browser_action`, `ask_followup_question`, `attempt_completion`

### OpenCLI (current, after issue #27 Phase 1)
`read`, `write`, `edit`, `glob`, `grep`, `ls`, `bash`, `think`, `web_fetch`, `todo_write`, `todo_read`
