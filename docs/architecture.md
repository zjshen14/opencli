# Architecture — OpenCLI

_Last updated: 2026-05-09. Keep in sync with the code — update this doc in the same commit as any structural change it describes._

## Design principles

1. **Provider-agnostic** — the Agent Core depends only on `LLMClient`; swapping or adding a provider is a single new file + a branch in the factory.
2. **Library / CLI separation** — `src/core/` and `src/providers/` are pure library code. They never read `process.env`, never import from `src/cli/` or `src/state/`. API keys and config are resolved by the CLI layer and passed as constructor arguments.
3. **Safety at two layers** — write tools are blocked in plan mode at the _agent_ level (tool definition filtering) AND at the _executor_ level (`readOnly` guard). Neither layer trusts the other alone.
4. **No circular imports** — enforced by layer ownership: `cli → core / providers / tools / skills / state`. Inner layers never import outer ones.
5. **Colocate tests** — `foo.ts` → `foo.test.ts` in the same directory.

---

## High-level structure

```
┌─────────────────────────────────────────────────────────────┐
│                         CLI Layer                            │
│  src/cli/   — input, rendering, REPL, session wiring        │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│                     Agent Core                               │
│  src/core/  — agent loop, context, executor, observability  │
└──────┬───────────────┬──────────────────┬───────────────────┘
       │               │                  │
┌──────▼──────┐  ┌─────▼──────┐  ┌───────▼───────┐  ┌───────────────┐
│  Providers  │  │   Tools    │  │    Skills     │  │     State     │
│ src/providers│  │ src/tools/ │  │ src/skills/   │  │ src/state/    │
│             │  │            │  │               │  │               │
│ LLMClient   │  │ File ops   │  │ Registry      │  │ Session JSONL │
│ Gemini      │  │ Bash exec  │  │ SKILL.md load │  │ Config JSON   │
│ Anthropic   │  │ Web fetch  │  │ Built-ins     │  │ Settings JSON │
│ OpenAI      │  │ Todo       │  │               │  │               │
│ Factory     │  │ Think      │  │               │  │               │
└─────────────┘  └────────────┘  └───────────────┘  └───────────────┘
```

---

## Component reference

### 1. CLI Layer — `src/cli/`

**Responsibilities:** parse CLI arguments, run the interactive REPL, render streamed output, intercept slash commands, wire API keys + config into the library layer.

This layer is the only place that reads `process.env` for API keys and imports from `src/state/`.

**Key files:**

```
src/cli/
  index.ts      Entry point — commander CLI (chat / run / sessions / config commands).
                Resolves config, API keys (via keys.ts), creates client, agent, and
                skill registry; starts REPL or one-shot run.
  repl.ts       Interactive REPL — readline loop, /slash command dispatch, plan
                approval workflow, session logging, confirm-fn construction.
  renderer.ts   MarkdownStreamRenderer (buffers to paragraph boundaries before
                rendering) + tool call display helpers.
  input.ts      Raw-mode readline, /slash popup with arrow-key navigation,
                tab-completion for skill names.
  keys.ts       resolveApiKey(provider, config) — reads env vars + config fields
                for all three providers; throws with a clear message if missing.
```

**Built-in REPL commands:**
- `/plan <task>` — read-only planning pass → readline approval menu (Approve / Edit / Cancel) → react-mode execution
- `/help`, `/clear`, `/exit` — housekeeping

**Slash command (skill) interception:**
1. Input starting with `/` is intercepted before forwarding to the Agent Core.
2. `/<skill-name> [args]` is looked up in `SkillRegistry`.
3. `!{cmd}` shell preprocessors are run; `$ARGUMENTS` is substituted.
4. Resulting content is injected into the Agent Core via `agent.injectSkill()`.

---

### 2. Agent Core — `src/core/`

**Responsibilities:** agentic loop, conversation context, parallel tool execution, plan-mode enforcement, observability events.

**Key files:**

```
src/core/
  agent.ts          Agent class — the agentic while-loop; plan-mode tool filtering;
                    max-turns and stuck-loop safety guards.
  context.ts        ContextManager — conversation history (sliding window), skill
                    content (never pruned), system instruction rendering + caching.
  executor.ts       executeCalls() — HITL confirmation gate, readOnly plan-mode guard,
                    parallel vs. sequential dispatch, output truncation.
  prompt.ts         DEFAULT_SYSTEM_INSTRUCTION template; renderSystemInstruction();
                    getGitContext(); buildPlanSuffix(); AGENT_REMINDERS.
  observability.ts  ObservabilityEvent union type + ObservabilityHandler alias.
```

#### Agentic loop (`agent.ts`)

```
1. Add user message to context.

2. Build tool definitions:
   - react mode: all registered tools + activate_skill
   - plan mode: tools where Tool.readonly === true, plus activate_skill
   Render system instruction (tool list embedded for prompt-cache stability).

3. Stream from LLMClient.stream(messages, systemInstruction, toolDefs).
   - text events → yield to caller immediately
   - function_call events → accumulate as pendingCalls
   - usage events → forward to observability handler

4. Append assistant turn (text + function calls) to context.

5. If no function calls → yield { type: "done" }, return.

6. Safety guards (checked each turn before tool execution):
   a. Max-turns (default 50, --max-turns to override):
      if turns > maxTurns → yield error event, return.
   b. Stuck-loop (3 identical consecutive call signatures):
      if stuckCount >= 3 → yield error event, return.

7. Execute all pending calls via executeCalls() (see executor below).

8. Append event-driven reminders to last tool result (AGENT_REMINDERS).
   Each reminder fires at most once per session (firedReminders Set).

9. Append tool results as a user message to context. Go to step 3.
```

#### Plan mode

Invoked via `Agent.run(input, "plan")`:
- Tool definitions filtered to `Tool.readonly === true` tools (dynamic — no hardcoded name list).
- System instruction extended with `buildPlanSuffix()` (structured template: Understand → Explore → Design → Plan; mandatory numbered checklist output).
- Executor additionally enforces `readOnly: true` as defence-in-depth (double guard).
- REPL shows a readline text menu after the plan is generated (replaced `@clack/prompts` due to stdin ownership conflict with raw-mode readline).
- On approval: plan injected as a synthetic user message; agent switches to `"react"` mode.

#### Executor (`executor.ts`)

`executeCalls(calls, deps)`:

1. Split calls into `skillCalls` (name === `"activate_skill"`) and `toolCalls`.
2. Handle skill activations — load body via `SkillRegistry`, inject into `ContextManager`. No tool result produced.
3. Dispatch tool calls:
   - **If any call is a write tool** (`Tool.readonly` is false/undefined): execute all **sequentially** in declared order — prevents race conditions (two edits to the same file, write followed by a dependent read).
   - **If all calls are readonly**: execute **in parallel** (`Promise.all`) for speed.
4. For each tool call — `executeOneCall()`:
   a. Plan-mode guard: if `deps.readOnly && !tool.readonly` → return blocked error result; emit `tool_denied` observability event.
   b. HITL gate: if `tool.requiresConfirmation?.(args)` → call `deps.confirmFn`. If no confirmFn or user denies → return blocked error result; emit `tool_denied`.
   c. Execute: call `deps.tools.execute(name, args)`.
   d. Combine `result.output + result.error` (both sent to model so it can see failure reasons).
   e. Truncate if tool is in `TRUNCATE_TOOLS` (`bash`, `grep`, `glob`) and output exceeds `MAX_TOOL_OUTPUT`.
   f. Emit `tool_exec_start` / `tool_exec_end` observability events.

**Output truncation:** middle-truncation — 30% head + 70% tail, elided chars reported. Full output saved to `{SESSION_TMP}/tool-output-<id>.txt` when session tmp dir is set. Configurable via `OPENCLI_MAX_TOOL_OUTPUT` (default 20 000 chars). `read` is excluded from truncation — agents rely on exact line spans for follow-up edits.

#### Observability (`observability.ts`)

`ObservabilityHandler` is `(event: ObservabilityEvent) => void`. Passed as an optional constructor option to `Agent` and threaded into `executeCalls`. Callers attach their own handler (e.g. the CLI emits these to a metrics sink or future OTel exporter).

Event types:

| Event | When |
|---|---|
| `llm_call_start` | Before each LLM streaming call |
| `llm_call_end` | After stream completes (includes token counts + latency) |
| `context_snapshot` | Before each call (message count + rough token estimate) |
| `tool_exec_start` | Before `tool.execute()` |
| `tool_exec_end` | After `tool.execute()` (latency, success, output bytes) |
| `tool_denied` | When a call is blocked (plan_mode / user_denied / non_interactive) |
| `guard_triggered` | When max-turns or stuck-loop fires |

#### Context management (`context.ts`)

`ContextManager` is the sole owner of context state for a session.

**System instruction** is rendered from a template (`DEFAULT_SYSTEM_INSTRUCTION` or `OPENCLI_SYSTEM_MD` override) and cached by tool-name signature. Cache invalidates when: tool list changes, `skillCatalog` changes, or `sessionTmpDir` changes.

Template placeholders: `{CWD}`, `{SESSION_TMP}`, `{TOOL_CATALOG}`, `{GIT_CONTEXT}`, `{SKILL_CATALOG}`.

**Git context** (`getGitContext()` in `prompt.ts`) is injected once at the start of each `getSystemInstruction()` render:
- Current branch + default branch
- `git status --short` (capped at 2 000 chars)
- Last 5 commits from `git log --oneline`
- Labelled as a snapshot: "_will not update during the conversation_"
- Silently empty if not a git repo or git is unavailable

**Conversation history** is a sliding window of the last `maxHistoryMessages` messages (default 50). Pruning includes an orphan-safety guard: the oldest retained message must be a `user` message that is not a `function_result` — ensures no orphaned tool results or leading model turns reach the API.

**Skill content** is held in a separate `skillContent[]` array, never pruned, tagged as `<skill_content name="...">`. Prepended as a synthetic `## Active Skills` user message when `getMessages()` is called.

**Event-driven reminders** (`AGENT_REMINDERS` in `prompt.ts`): after each tool-execution round, `buildReminder()` appends a short reminder to the last tool result. Currently fires on:
- `write` or `edit` → "verify the change works — find and run the project's test command"
- `write` or `edit` → "don't add features or refactoring beyond what was asked"
- `bash` with `git` in the command → "never commit or push without an explicit user request"
Each reminder fires at most once per session.

---

### 3. Providers — `src/providers/`

**Responsibilities:** implement `LLMClient`, translate internal types to each provider's wire format, handle retries.

**Key files:**

```
src/providers/
  client.ts      LLMClient interface — the sole abstraction the Agent Core depends on.
  types.ts       Shared types: Message, StreamEvent, ToolDefinition, FunctionCallPart,
                 FunctionResultPart, thoughtSignature.
  factory.ts     createClient(model, apiKey, options) — provider detection + client
                 construction. detectProvider() + hasNativeThinking() helpers.
  gemini.ts      GeminiClient — Gemini wire format, thoughtSignature threading,
                 uppercase type conversion.
  anthropic.ts   AnthropicClient — Anthropic wire format, tool_use/tool_result blocks,
                 role mapping (model → assistant).
  openai.ts      OpenAIClient — OpenAI Chat Completions wire format.
  retry.ts       withRetry<T>() — generic async generator retry with exponential
                 backoff; shared by all provider clients.
  schema.ts      toolToDefinition() — converts Tool → plain-JSONSchema ToolDefinition.
                 activateSkillDefinition — the activate_skill pseudo-tool definition.
```

#### Provider detection (`factory.ts`)

`detectProvider(model)` infers the provider from the model name prefix:

| Prefix | Provider | Client |
|---|---|---|
| `claude-` | `anthropic` | `AnthropicClient` |
| `gpt-`, `o1`, `o3`, `o4` | `openai` | `OpenAIClient` |
| anything else | `gemini` | `GeminiClient` (default) |

`hasNativeThinking(model)` returns true for Gemini thinking / 2.5+ / 3.x models, causing `createDefaultRegistry()` to omit the `think` tool (avoids double-paying for reasoning).

**Known limitation:** prefix detection breaks for proxies, fine-tunes, and custom aliases. Tracked as [#54](https://github.com/zjshen14/opencli/issues/54) — Phase B2 adds explicit `provider` override + `--base-url` to the config.

#### Tool definitions vs. tool execution

`schema.ts` converts `Tool` → `ToolDefinition` (plain JSONSchema, no provider SDK imports). Each provider client translates `ToolDefinition[]` into its own wire format internally:

- **Gemini:** `"object"` → `"OBJECT"` (uppercase types); `functionCall` / `functionResponse` message parts; `thoughtSignature` threaded from `functionCall` back through `functionResponse` on thinking models.
- **Anthropic:** `role: "model"` → `"assistant"`; `tool_use` / `tool_result` content blocks; `thoughtSignature` ignored.
- **OpenAI:** standard Chat Completions `tool_calls` / `tool` role message format.

#### Retry (`retry.ts`)

`withRetry(factory, isRetryable, maxRetries=3, baseMs=1000)` wraps any `AsyncGenerator` factory with exponential-backoff retry. Each provider client passes its own `isRetryable` predicate (checks typed SDK error classes — `GoogleGenerativeAIError`, `Anthropic.APIError`, etc.).

---

### 4. Tools — `src/tools/`

**Key files:**

```
src/tools/
  base.ts          Tool interface + JSONSchema type.
  registry.ts      ToolRegistry — register, get, all(), execute().
  index.ts         createDefaultRegistry(model?, runner?) — registers all built-in tools;
                   omits think for native-thinking models; injects SandboxRunner into bash.
  think.ts         think tool — private scratchpad; result suppressed in REPL display.
  file/
    read.ts        Read file contents (offset + limit support).
    write.ts       Create or overwrite files (requiresConfirmation outside CWD).
    edit.ts        Exact old_string → new_string replacement (fails if ambiguous).
    glob.ts        Find files by pattern.
    grep.ts        Regex search across file contents.
    ls.ts          List directory contents.
  exec/
    bash.ts        createBashTool(runner) factory — SAFE_COMMANDS allowlist;
                   requiresConfirmation for anything not on the list;
                   rejects model-supplied cwd outside project root before calling runner.
    sandbox/
      types.ts         SandboxMode, SandboxExecOptions, SandboxExecResult, SandboxRunner.
      passthrough.ts   PassthroughRunner — wraps spawn("bash"); used for mode "off" and
                       as a fallback when native sandboxing is unavailable. Also exports
                       the shared spawnAndCollect() helper.
      sandbox-exec.ts  SandboxExecRunner — macOS sandbox-exec; writes a per-startup .sb
                       profile to /tmp; denies network and writes outside CWD + /tmp.
      bwrap.ts         BwrapRunner — Linux bubblewrap; probes user-namespace availability
                       at construction; falls back to PassthroughRunner with a warning if
                       bwrap is missing or namespaces are disabled.
      index.ts         createSandboxRunner(mode, cwd) — platform dispatch factory;
                       re-exports all public types and classes.
  task/
    todo.ts        todo_write + todo_read — structured task list for multi-step work.
  web/
    fetch.ts       web_fetch — HTTP GET with content extraction.
```

#### Sandbox layer

The sandbox layer wraps every `bash` execution with OS-level isolation. It is layered *after* the HITL confirmation gate — both layers must pass before a command runs.

**`SandboxRunner` interface** is the single abstraction the `bash` tool depends on:

```typescript
interface SandboxRunner {
  readonly mode: SandboxMode;   // "auto" | "strict" | "off"
  readonly warning: string | null;  // non-null when isolation was downgraded
  exec(command: string, opts: SandboxExecOptions): Promise<SandboxExecResult>;
}
```

**Mode resolution** (highest to lowest precedence):

1. `--sandbox <mode>` CLI flag
2. `OPENCLI_SANDBOX` environment variable
3. `sandbox` field in `~/.opencli/config.json`
4. Default: `"auto"`

**Platform dispatch** (`createSandboxRunner`):

| Platform | Mode `"auto"` | Mode `"off"` |
|----------|--------------|-------------|
| macOS | `SandboxExecRunner` (sandbox-exec) | `PassthroughRunner` |
| Linux | `BwrapRunner` (bwrap) | `PassthroughRunner` |
| Other | `PassthroughRunner` + warning | `PassthroughRunner` |

**Startup warning**: `runner.warning` is emitted exactly once to `stderr` at CLI startup if isolation was downgraded (e.g. bwrap missing, namespaces disabled, unsupported platform).

#### Tool interface

```typescript
interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;

  /** true = read-only; passed in plan mode. false/undefined = write tool, blocked in plan mode. */
  readonly?: boolean;

  execute: (params: Record<string, unknown>) => Promise<ToolResult>;

  /** Return true to require interactive confirmation before execution. */
  requiresConfirmation?: (args: Record<string, unknown>) => boolean;

  /** Return an error string if params are invalid, null if valid.
   *  Called by ToolRegistry.execute() before execute() — after required-field check. */
  validate?: (params: Record<string, unknown>) => string | null;
}

interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}
```

#### Registry execution pipeline (`registry.ts`)

`ToolRegistry.execute(name, params)` runs three checks before calling `tool.execute()`:

1. Tool lookup — returns `Unknown tool` error if not found.
2. Required-field check — inspects `tool.parameters.required[]`; returns `Missing required parameter` if any are absent.
3. Custom validation — calls `tool.validate?.(params)`; returns the error string if non-null.

Only if all three pass is `tool.execute(params)` called.

#### `requiresConfirmation` policy

| Tool | Triggers confirmation |
|---|---|
| `bash` | Any command not in `SAFE_COMMANDS` allowlist |
| `write` | Path outside `process.cwd()` |
| `edit` | Path outside `process.cwd()` |

---

### 5. Skills — `src/skills/`

Skills are `SKILL.md` files — YAML frontmatter + Markdown instructions — injected into context on activation. They follow the [Agent Skills open standard](https://agentskills.io).

**Key files:**

```
src/skills/
  registry.ts    Discover, parse, and catalog SKILL.md files across all scoped
                 directories. catalogSummary() renders the {SKILL_CATALOG} block.
  loader.ts      Load skill body, run !{cmd} preprocessors, substitute $ARGUMENTS.
  builtin/       Built-in skill SKILL.md files (shipped with the binary):
    commit/      Draft and create a git commit (disable-agent-invocation: true)
    review/      Code review for correctness, style, security
    explain/     Explain code or a concept
    debug/       Diagnose and fix a reported error
    test/        Write tests for a function or module
    run-tests/   Detect test framework, run suite, surface failures
    typecheck/   Run tsc/mypy, report type errors by file
    lint/        Run linter with optional auto-fix
    gh-issue/    Create, view, list, comment on GitHub issues
    gh-pr/       Open, review, check CI, merge GitHub PRs
    branch/      Create feature branches tied to issue numbers
    new-skill/   Scaffold a custom SKILL.md interactively (disable-agent-invocation)
```

#### Discovery priority (first match wins)

```
<project>/.opencli/skills/<name>/SKILL.md      # project-scoped
<project>/.agents/skills/<name>/SKILL.md       # cross-client convention (agentskills.io)
~/.opencli/skills/<name>/SKILL.md             # user-global
<binary>/builtin/<name>/SKILL.md               # bundled built-ins
```

#### Three-tier loading

| Tier | Content | Loaded when | Token cost |
|---|---|---|---|
| Catalog | name + description only | Session start (always) | ~50–100 / skill |
| Body | Full SKILL.md instructions | On activation | < 5 000 recommended |
| Resources | Scripts, reference files | When referenced in body | On demand |

#### Invocation paths

1. **User-explicit** (`/skill-name [args]`): CLI layer intercepts, preprocesses, calls `agent.injectSkill(name, body)`.
2. **Model-driven**: LLM calls `activate_skill({ name })` → executor loads body + calls `context.addSkillContent()`. No tool result produced.

Activated skill content is tagged `<skill_content name="...">` and prepended (never pruned) as a synthetic user message.

---

### 6. State — `src/state/`

**Key files:**

```
src/state/
  config.ts      Config load/save — ~/.opencli/config.json. Exports AGENT_DIR,
                 Config interface, loadConfig(), saveConfig(). Migrates legacy
                 field names on read (e.g. apiKey → geminiApiKey).
  session.ts     Session: create, list, loadMessages(), log, tmpDir.
  settings.ts    Settings load/save — <project>/.opencli/settings.json.
                 Holds Permissions (HITL allow-list) persisted across sessions.
```

#### Config (`~/.opencli/config.json`)

```json
{
  "model": "gemini-3.1-flash-lite-preview",
  "geminiApiKey": "...",
  "anthropicApiKey": "...",
  "openaiApiKey": "...",
  "maxTokens": 8192,
  "temperature": 0.7,
  "historySize": 50
}
```

Environment variables override config file values:

| Variable | Overrides |
|---|---|
| `GEMINI_API_KEY` | `config.geminiApiKey` |
| `ANTHROPIC_API_KEY` | `config.anthropicApiKey` |
| `OPENAI_API_KEY` | `config.openaiApiKey` |
| `OPENCLI_MODEL` | `config.model` (beats `--model` flag too) |
| `OPENCLI_SYSTEM_MD` | Path to a Markdown file replacing the default system instruction |
| `OPENCLI_MAX_TOOL_OUTPUT` | Per-tool output cap in chars (default 20 000) |

#### Settings (`.opencli/settings.json` — project-scoped)

```json
{
  "permissions": {
    "allow": ["bash:git status", "bash:npm test"],
    "deny":  []
  }
}
```

The HITL confirmation function (`createConfirmFn` in `repl.ts`) persists "Yes always" decisions to this file so they survive across sessions. The project-scoped file is checked first; a global `~/.opencli/settings.json` is the fallback for user-wide rules.

#### Sessions (`~/.opencli/projects/<encoded-cwd>/<session-id>.jsonl`)

Each JSONL line is a discriminated union entry: `session_start | user | assistant | tool_call | tool_result`. Session ID format: `YYYY-MM-DDTHH-mm-ss` (human-readable, lexicographically sortable).

`Session.loadMessages(id | "latest")` reconstructs `Message[]` from the log. `"latest"` selects the most recent session that contains actual conversation content (non-empty `user` + `assistant` pairs).

Scratch directory: `<cwd>/.opencli/tmp/<session-id>/` — agent-generated temp files land here, never in the project root.

---

## Data flow

### Standard interaction

```
User: "Update the version in package.json to 2.0.0"
  │
  └─▶ CLI Layer (repl.ts)
        │  resolve input, start agent turn
        └─▶ Agent Core (agent.ts)
              │  build context: history + system instruction (with git snapshot, tool catalog)
              └─▶ LLMClient.stream()
                    │
                    ├─▶ text event: "I'll read the file first"
                    │     → yield to CLI, render to terminal
                    │
                    └─▶ function_call: read({ file_path: "package.json" })
                          │
                          └─▶ executeCalls()
                                │  requiresConfirmation? no → execute
                                └─▶ read.execute() → file contents
                                      │
                                      └─▶ feed result back to LLM as user message
                                            │
                                            └─▶ function_call: edit({ old: "1.0.0", new: "2.0.0" })
                                                  │
                                                  └─▶ executeOneCall()
                                                        requiresConfirmation? yes (outside CWD?) → no → execute
                                                        edit.execute() → success
                                                        append reminder: "verify the change works"
                                                          │
                                                          └─▶ LLM final text: "Updated to 2.0.0"
                                                                │
                                                                └─▶ CLI Layer renders, logs to session JSONL
```

### Plan-mode flow

```
User: /plan refactor auth module
  │
  └─▶ CLI Layer intercepts slash command
        │  run Agent.run(input, "plan")
        └─▶ Agent Core
              │  toolDefs = tools where readonly === true
              │  systemInstruction += buildPlanSuffix(allowedToolNames)
              │  executes read-only exploration pass
              └─▶ produces plan (numbered checklist with file paths + risks)
                    │
                    └─▶ CLI Layer shows readline menu: [a]pprove / [e]dit / [c]ancel
                          │
                          ├─▶ approve → agent.run(plan as context, "react") → execute
                          ├─▶ edit   → open $EDITOR, user modifies plan, then execute
                          └─▶ cancel → discard, return to prompt
```

---

## Layer constraints (enforced by convention, linted manually)

| Layer | May import from | Must never import from |
|---|---|---|
| `src/cli/` | all layers | — |
| `src/core/` | `providers/`, `tools/`, `skills/` | `cli/`, `state/` |
| `src/providers/` | `providers/` only | `cli/`, `core/`, `tools/`, `skills/`, `state/` |
| `src/tools/` | `providers/types` | `cli/`, `core/`, `providers/` (non-types), `state/` |
| `src/skills/` | Node builtins | `cli/`, `core/`, `providers/`, `tools/`, `state/` |
| `src/state/` | Node builtins, `providers/factory` (for Provider type) | `cli/`, `core/` |

---

## Testing strategy

- **Unit tests colocated** with source (`agent.ts` → `agent.test.ts`).
- **Real filesystem** for file tool tests — no `fs` mocking (mocks hide path-handling bugs).
- **Mock at boundaries** — `LLMClient` and `SkillRegistry` are mocked; internal collaborators (`ContextManager`, `ToolRegistry`) are used directly.
- **E2E tests** (`*.e2e.test.ts`) run the full agent pipeline against a mock `LLMClient` that emits scripted tool calls.
- **Smoke tests** (`cli/run.smoke.test.ts`) exercise the built binary with real filesystem I/O.

---

## References

- [Strategic roadmap](roadmap.md) — positioning, phase plan, deferred items
- [Skills authoring guide](skills.md) — SKILL.md format, preprocessors, custom skills
- [Tool gaps research](tool-gaps-research.md) — LSP, web search, code navigation comparison
- [CLI UX research](cli-ux-research.md) — input handling and rendering comparison vs. peers
- [Engineering practices](engineering-practices.md) — contribution rules, test policy
- [Agent Skills open standard](https://agentskills.io/specification)
