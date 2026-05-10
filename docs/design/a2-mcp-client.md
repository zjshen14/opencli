# Design: A2 — MCP client

_Status: Implemented — merged in cbe9f49 (2026-05-09). Tracking issue: [#81](https://github.com/zjshen14/opencli/issues/81). Phase: [Roadmap A2](../roadmap.md)._

_Revision history:_
- _2026-05-09 — incorporated technical review (async shutdown, output truncation flag, error-handling pattern, name-sanitisation moved to manager, hard collision error, `${VAR}`-only expansion, indexed-name fragility, per-server timeout in config)._
- _2026-05-09 — added user-facing CLI surface (`opencli mcp add/list/test/remove`, `/mcp` slash command, per-server HITL allow option). Reversed Q4 from "defer" to "ship with A2"._

---

## Problem and goal

OpenCLI's tool surface is fixed at build time. Any capability the user wants (GitHub, filesystem, databases, external APIs) must be implemented as a first-party tool or skill. This is a significant constraint for an agent that's positioning as the open, provider-agnostic option.

The [Model Context Protocol](https://modelcontextprotocol.io) (MCP) is a standardised JSON-RPC protocol for AI agents to discover and call tools hosted in external server processes. It is supported by Claude Desktop, Codex, Cursor, and others. Shipping MCP client support gives OpenCLI immediate access to an ecosystem of hundreds of community servers.

**Goal:** load MCP servers from `~/.opencli/mcp.json`, discover their tools at startup, register those tools into `ToolRegistry` under a namespaced name (`mcp__<server>__<tool>`), and route calls through the executor with the same HITL confirmation and plan-mode guards that built-in tools receive.

### Sequencing rationale (A1 before A2)

The sandbox design (A1) ships first. MCP servers run as subprocesses or network endpoints outside OpenCLI's control. Every MCP tool call must pass through the HITL confirmation gate, and the design must be clear that the MCP server process itself is **not** sandboxed in A2 — that is a deliberate, documented trade-off, not an oversight. Container sandboxing of MCP servers is Phase C4.

### What this does NOT do

- **Does not sandbox the MCP server process.** The server subprocess runs with the same OS privileges as the OpenCLI process. HITL confirmation provides visibility and an approval gate, not isolation.
- **Does not support MCP resources or prompts.** Only the `tools` namespace is wired in A2. Resources and prompts are deferred.
- **Does not implement MCP server mode.** OpenCLI-as-MCP-server is Phase C2, a separate design.
- **Does not mutate `createDefaultRegistry`.** MCP tools are registered by the CLI layer after the base registry is created — the factory function stays clean.

### Tangential change shipped with A2

The executor currently truncates large outputs via a hardcoded `TRUNCATE_TOOLS = Set(["bash", "grep", "glob"])`. This is broken for MCP — a filesystem MCP server returning a 5 MB file would silently flood the agent context. Two options were considered:

1. Hardcode `name.startsWith("mcp__")` in the executor — leaks the MCP namespace into a layer that should not know about it.
2. Move the policy to `Tool.truncateOutput?: boolean` — the registry no longer needs to know which tools produce large output.

Option 2 wins. A2 ships this change:

- Add `truncateOutput?: boolean` to the `Tool` interface (`src/tools/base.ts`).
- Migrate `bash`, `grep`, `glob` to set `truncateOutput: true` on their tool objects.
- Remove the `TRUNCATE_TOOLS` Set from `executor.ts`; replace the lookup with `tool?.truncateOutput`.
- The MCP adapter sets `truncateOutput: true` on every MCP tool.

This is a self-contained refactor (~10 LOC change in three files plus the executor) and is required for A2 correctness, so it ships as part of this PR rather than as a follow-up.

---

## Interface contracts

### New package dependency

```
@modelcontextprotocol/sdk   ^1.x   (production dependency)
```

This is the official TypeScript SDK from the MCP authors. It handles JSON-RPC framing, stdio/HTTP transport, reconnection, and schema types. Implementing the protocol from scratch would be significant maintenance burden with no upside.

### New files

```
src/mcp/
  types.ts       McpServerConfig (stdio | http), McpConfig, McpToolInfo
  client.ts      McpClient: wraps SDK Client, exposes connect/listTools/callTool/close
  adapter.ts     mcpToolToTool(): bridges McpToolInfo → Tool (requiresConfirmation always true)
  manager.ts     McpManager: load config, connect all servers, register tools, disconnectAll
  config.ts      loadMcpConfig(agentDir): reads ~/.opencli/mcp.json
  index.ts       re-exports
```

### `types.ts`

```typescript
/** Stdio-transport server: spawns a subprocess. */
export interface McpStdioServer {
  transport: "stdio";
  command: string;
  args?: string[];
  /** Merged over process.env before spawning. */
  env?: Record<string, string>;
}

/** HTTP-transport server: connects to a running URL (SSE or Streamable HTTP). */
export interface McpHttpServer {
  transport: "http";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig = McpStdioServer | McpHttpServer;

export interface McpConfig {
  /** Keyed by server name (e.g. "filesystem", "github"). Names must be [a-zA-Z0-9_-]. */
  mcpServers: Record<string, McpServerConfig>;
}

/** Subset of MCP Tool schema used internally. */
export interface McpToolInfo {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
```

### `~/.opencli/mcp.json` format

```jsonc
{
  "mcpServers": {
    "filesystem": {
      "transport": "stdio",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
    },
    "github": {
      "transport": "http",
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer ${GITHUB_TOKEN}" }
    }
  }
}
```

`transport` defaults to `"stdio"` when the field is absent, for backward compatibility with the Claude Desktop config format (which has no `transport` key for stdio servers).

**Variable expansion:** `${VAR}` references in string values are expanded against `process.env` at load time. Only the braced form is recognised — bare `$VAR` is left as a literal so the user does not get surprise expansion of strings like API tokens, paths, or shell-style references they did not intend. Expansion is limited to string values, non-recursive, no shell metacharacters. Unset variables become empty strings with a startup warning.

A literal `${` can be escaped as `$${` (the loader strips one `$` and emits the rest as-is). This is documented in the README; the test suite covers it.

### `config.ts`

```typescript
export async function loadMcpConfig(agentDir: string): Promise<McpConfig | null>;
```

Returns `null` if `mcp.json` does not exist. Returns `null` with a stderr warning if the file is malformed JSON. Does NOT throw.

### `client.ts`

```typescript
export interface McpClientOpts {
  /** Per-call timeout in milliseconds. Default: 30_000. */
  callTimeout?: number;
}

export class McpClient {
  readonly serverName: string;

  constructor(name: string, config: McpServerConfig, opts?: McpClientOpts);

  /** Spawn/connect the server and perform the MCP initialize handshake. */
  async connect(): Promise<void>;

  /** Returns all tools advertised by the server. */
  async listTools(): Promise<McpToolInfo[]>;

  /** Call a single tool. Returns { success, output, error? } in OpenCLI's ToolResult format. */
  async callTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult>;

  /** Terminate the connection / subprocess cleanly. */
  async close(): Promise<void>;
}
```

#### Implementation notes — `McpClient`

```typescript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Inside connect():
let transport;
if (config.transport === "http") {
  transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: config.headers },
  });
} else {
  // Stdio: merge config.env over process.env so the subprocess sees both
  // the parent's environment (PATH etc.) and any server-specific overrides.
  const childEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(config.env ?? {}),
  };
  transport = new StdioClientTransport({
    command: config.command,
    args: config.args,
    env: childEnv,
  });
}

this.sdkClient = new Client({ name: "opencli", version: "0.1.0" });
await this.sdkClient.connect(transport);
```

For `callTool()`, wrap the SDK result into `ToolResult`. **Note the explicit try/catch** — the SDK throws on transport errors and `AbortSignal.timeout` raises `AbortError` rather than returning a value, so the failure paths in the table above all flow through this handler:

```typescript
async callTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
  try {
    const result = await this.sdkClient.callTool(
      { name: toolName, arguments: args },
      undefined,
      { signal: AbortSignal.timeout(this.callTimeout) },
    );
    const textParts = result.content
      .filter((c) => c.type === "text")
      .map((c) => (c as { type: "text"; text: string }).text);
    const droppedNonText = result.content.length - textParts.length;
    let output = textParts.join("\n");
    if (droppedNonText > 0) {
      output += `\n[${droppedNonText} non-text content block(s) omitted]`;
    }
    return result.isError
      ? { success: false, output, error: output || "MCP tool returned an error" }
      : { success: true, output };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isTimeout = err instanceof Error && err.name === "TimeoutError";
    return {
      success: false,
      output: "",
      error: isTimeout
        ? `MCP tool '${toolName}' timed out after ${this.callTimeout}ms`
        : `MCP tool '${toolName}' failed: ${message}`,
    };
  }
}
```

Image/blob content blocks are dropped; the count of dropped blocks is appended to `output`. Non-text content can be plumbed through in a follow-on PR when there's a concrete use case.

### `adapter.ts`

```typescript
import type { Tool } from "../tools/base.js";
import type { McpClient } from "./client.js";
import type { McpToolInfo } from "./types.js";

/**
 * Bridges one MCP tool into an OpenCLI Tool.
 *
 * Tool name format: mcp__<sanitisedServerName>__<toolName>
 * (double-underscore, matching Claude Code's convention for compatibility)
 *
 * All MCP tools require HITL confirmation — the user chose to install the
 * server but did not pre-approve every individual call. Allow-listing a
 * specific tool by name persists to .opencli/settings.json via the standard
 * HITL flow with no special handling needed here.
 *
 * MCP tools are write tools (readonly = false) — blocked in plan mode.
 * MCP tools have truncateOutput = true so the executor caps oversized payloads
 * the same way it does for bash/grep/glob.
 *
 * The adapter receives the already-sanitised server name from the manager —
 * it does not sanitise itself, to avoid duplicate warnings (one per tool).
 */
export function mcpToolToTool(
  client: McpClient,
  sanitisedServerName: string,
  info: McpToolInfo,
): Tool {
  return {
    name: `mcp__${sanitisedServerName}__${info.name}`,
    description: `[${client.serverName}] ${info.description}`,
    parameters: info.inputSchema as Tool["parameters"],
    readonly: false,
    truncateOutput: true,
    requiresConfirmation: () => true,
    execute: (params) => client.callTool(info.name, params),
  };
}
```

**Name sanitisation lives in `manager.ts`, not here.** The manager sanitises each server name once at registration time (`[^a-zA-Z0-9_-]` → `_`), logs a single warning per affected server, and detects collisions across servers (see `registerTools` below). Per-tool sanitisation in the adapter would emit one warning per tool from the same server, which is noise.

### `manager.ts`

```typescript
interface ConnectedServer {
  client: McpClient;
  /** Original name from mcp.json. */
  rawName: string;
  /** Sanitised: [^a-zA-Z0-9_-] replaced with _. */
  sanitisedName: string;
}

export class McpManager {
  constructor(private servers: ConnectedServer[]) {}

  /** Connect all servers concurrently. Failed servers are logged but do not abort startup. */
  static async create(config: McpConfig, opts?: McpClientOpts): Promise<McpManager>;

  /** Register all successfully-connected servers' tools into the given registry. */
  async registerTools(registry: ToolRegistry): Promise<void>;

  /** Close all connections. Called from the CLI shutdown handler. */
  async disconnectAll(): Promise<void>;

  /** Number of servers that connected successfully. */
  get connectedCount(): number;
}
```

#### `McpManager.create()` — startup flow

The previous draft inferred the server name by indexing `Object.keys()` against the `Promise.allSettled` result array. That's brittle (relies on Object.keys/entries returning identical order), so capture the name inside the entries callback and carry it through.

```typescript
type ConnectAttempt =
  | { ok: true; server: ConnectedServer }
  | { ok: false; rawName: string; error: unknown };

static async create(config: McpConfig, opts?: McpClientOpts): Promise<McpManager> {
  const sanitise = (name: string): string => name.replace(/[^a-zA-Z0-9_-]/g, "_");

  // Build the sanitised name table once, up front, and detect cross-server collisions
  // BEFORE attempting any connections. A collision is a hard error for the offending
  // entries — the second one is dropped from the connection attempt and logged.
  const sanitisedByRaw = new Map<string, string>();  // rawName -> sanitised
  const claimedSanitised = new Map<string, string>(); // sanitised -> first rawName that claimed it
  const skippedDueToCollision: string[] = [];

  for (const rawName of Object.keys(config.mcpServers)) {
    const sanitised = sanitise(rawName);
    if (sanitised !== rawName) {
      process.stderr.write(
        `[mcp] '${rawName}': name sanitised to '${sanitised}' for tool naming\n`,
      );
    }
    const previousClaimer = claimedSanitised.get(sanitised);
    if (previousClaimer !== undefined) {
      process.stderr.write(
        `[mcp] '${rawName}': sanitised name '${sanitised}' collides with '${previousClaimer}' — skipping. Rename one in mcp.json.\n`,
      );
      skippedDueToCollision.push(rawName);
      continue;
    }
    claimedSanitised.set(sanitised, rawName);
    sanitisedByRaw.set(rawName, sanitised);
  }

  const attempts = await Promise.all<Promise<ConnectAttempt>>(
    Object.entries(config.mcpServers)
      .filter(([rawName]) => !skippedDueToCollision.includes(rawName))
      .map(async ([rawName, serverConfig]): Promise<ConnectAttempt> => {
        try {
          const client = new McpClient(rawName, serverConfig, opts);
          await client.connect();
          return {
            ok: true,
            server: { client, rawName, sanitisedName: sanitisedByRaw.get(rawName)! },
          };
        } catch (error) {
          return { ok: false, rawName, error };
        }
      }),
  );

  const servers: ConnectedServer[] = [];
  for (const attempt of attempts) {
    if (attempt.ok) {
      servers.push(attempt.server);
    } else {
      const msg = attempt.error instanceof Error ? attempt.error.message : String(attempt.error);
      process.stderr.write(`[mcp] '${attempt.rawName}': failed to connect — ${msg}\n`);
    }
  }
  return new McpManager(servers);
}
```

#### `McpManager.registerTools()` — tool listing flow

```typescript
async registerTools(registry: ToolRegistry): Promise<void> {
  for (const { client, sanitisedName } of this.servers) {
    let tools: McpToolInfo[];
    try {
      tools = await client.listTools();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[mcp] '${client.serverName}': listTools failed — ${msg}\n`);
      continue;
    }
    for (const info of tools) {
      registry.register(mcpToolToTool(client, sanitisedName, info));
    }
  }
}
```

Within a single sanitised server name, the MCP server is responsible for ensuring its own tool names are unique (the SDK enforces this on the server side). The cross-server collision case was already addressed at sanitisation time, so by the time `registerTools` runs, every `mcp__<sanitised>__<tool>` name is guaranteed unique.

### `index.ts`

```typescript
export { McpManager } from "./manager.js";
export { McpClient } from "./client.js";
export { mcpToolToTool } from "./adapter.js";
export { loadMcpConfig } from "./config.js";
export type { McpConfig, McpServerConfig, McpToolInfo } from "./types.js";
```

---

## Data flow

### Startup sequence

```
cli/index.ts
  1. loadConfig()                         → Config
  2. loadMcpConfig(AGENT_DIR)             → McpConfig | null
  3. createDefaultRegistry(model, runner) → ToolRegistry (built-ins only)
  4. if (mcpConfig):
       McpManager.create(mcpConfig)       → McpManager
       manager.registerTools(registry)    → adds mcp__*__* tools
  5. new Agent(client, registry, ...)
  6. process.on("exit", () => manager.disconnectAll())
```

### Tool call sequence

```
Agent (agentic loop)
  → yields function_call { name: "mcp__filesystem__read_file", args: { path: "/tmp/foo" } }
  → executor.executeCalls()
      → executeOneCall()
          → tool.requiresConfirmation() = true → confirmFn → "allow"
          → registry.execute("mcp__filesystem__read_file", { path: "/tmp/foo" })
              → Tool.execute() = McpClient.callTool("read_file", { path: "/tmp/foo" })
                  → JSON-RPC tools/call over stdio / HTTP
                  → response: { content: [{ type: "text", text: "file contents..." }] }
              → ToolResult { success: true, output: "file contents..." }
  → FunctionResultPart appended to context
  → loop continues
```

### Plan mode

MCP tools have `readonly: false`. They are blocked in plan mode (same as `write`, `edit`, `bash`). The executor returns:

```
Error: 'mcp__filesystem__write_file' is blocked in plan mode.
Use read, glob, or grep to explore the codebase.
```

---

## User-facing CLI surface

The connection layer above is invisible to end users. Without a config-management UX, MCP support ships as "edit a JSON file by hand and hope you got it right." A2 ships a small set of subcommands that close that gap. They are wrappers on the same `McpClient`/`McpManager` primitives the REPL uses — no new protocol code.

Interactive prompts use `@clack/prompts` (already a dependency, used by the existing `/plan` flow).

### `opencli mcp add [name] [-- command args...]`

Interactive when called without args, one-shot when called with them.

```
$ opencli mcp add
? Server name › filesystem
? Transport › ● stdio   ○ http
? Command › npx
? Args (space-separated, accepts quoted strings) › -y @modelcontextprotocol/server-filesystem /tmp
? Test connection now? (Y/n) › Y

[mcp] connecting to filesystem...
[mcp] ✓ connected — 3 tools: read_file, write_file, list_directory

? Save to ~/.opencli/mcp.json? (Y/n) › Y
Saved.
```

One-shot form for power users / scripting:

```
$ opencli mcp add filesystem -- npx -y @modelcontextprotocol/server-filesystem /tmp
[mcp] testing connection...
[mcp] ✓ connected (3 tools)
[mcp] saved to ~/.opencli/mcp.json
```

HTTP form:

```
$ opencli mcp add github --transport http --url http://localhost:3000/mcp \
    --header "Authorization: Bearer \${GITHUB_TOKEN}"
```

Behaviour:
- Refuses to overwrite an existing entry without `--force`.
- Always runs the connection probe before saving (a one-shot connect → `listTools` → disconnect). If the probe fails, prompts for "save anyway?" with a default of No.
- Validates the server name against the sanitisation rule (`[a-zA-Z0-9_-]`) and rejects names that would require sanitisation. The error is much clearer when it fires here than at startup.

### `opencli mcp list`

```
$ opencli mcp list
NAME         TRANSPORT  STATUS    TOOLS
filesystem   stdio      ok        3 (read_file, write_file, list_directory)
github       http       ok        12
slow-db      stdio      timeout   —
```

`STATUS` runs the probe in parallel for all configured servers. `--no-probe` skips the probe and just shows the configured names (faster; useful in scripts).

### `opencli mcp test <name>`

Connects once, lists tools, disconnects. The "did I write the config correctly?" loop without spinning up a full REPL.

```
$ opencli mcp test filesystem
[mcp] connecting...
[mcp] ✓ ok — 3 tools advertised in 240ms
       • read_file
       • write_file
       • list_directory
```

Exit code: 0 on success, 1 on failure. Suitable for CI smoke tests.

### `opencli mcp remove <name>`

```
$ opencli mcp remove filesystem
Remove 'filesystem' from ~/.opencli/mcp.json? (y/N) › y
Removed.
```

`--yes` skips the prompt.

### Shared module — `src/cli/mcp-cmd.ts`

The four subcommands live in one new file (`src/cli/mcp-cmd.ts`) registered on the existing commander instance in `cli/index.ts`. Each command is ~30 LOC. They share two helpers:

- `probeServer(name, config): Promise<{ ok: boolean; tools?: string[]; error?: string; latencyMs?: number }>` — wraps a one-shot connect/listTools/disconnect cycle.
- `writeMcpConfig(updater)` — read-modify-write `~/.opencli/mcp.json` with file locking via `mkdir -p` and atomic rename (`writeFileSync(tmp); renameSync(tmp, final)`).

---

## In-REPL UX

### HITL prompt — name the server, offer per-server allow

The current confirmation prompt (`src/cli/repl.ts:createConfirmFn`) shows tool name and a one-line detail. For MCP tools the prompt expands to make provenance clear and to add a per-server allow option:

```
  ⚠  mcp__filesystem__write_file requires confirmation
     Server: filesystem  (stdio: npx -y @modelcontextprotocol/server-filesystem /tmp)
     Args:   { path: "/tmp/x.txt", contents: "..." }

  Allow mcp__filesystem__write_file?
    > y  Yes, run once
      p  Yes, always for this exact call             (project)
      g  Yes, always for this exact call             (global)
      t  Yes, always for this tool, any args         (project)
      s  Yes, always for any tool from 'filesystem'  (project)
      n  No, skip
```

For non-MCP tools the prompt is unchanged — the new `t`/`s` choices only render when the tool name starts with `mcp__`.

### Allow-list key extensions

Today the allow-set stores keys of the form `${toolName}:${JSON.stringify(args)}`. To support the two new "always" options the matcher accepts three patterns:

| Pattern | Meaning | Generated by |
|---|---|---|
| `tool:<args-json>` | Exact match (existing) | `y` choice (`p`/`g` scope) |
| `tool:*` | Any args for this tool | `t` choice |
| `mcp__<server>__*` | Any tool from this MCP server (any args) | `s` choice |

The check function tries exact → tool-wildcard → server-wildcard in that order. No regex; just three string-key lookups. Storage format in `settings.json` is unchanged — wildcards are just strings with `*` in them.

The `s` (server-wildcard) option only appears when the tool name matches `mcp__<server>__*`. The matcher derives the server from the prefix; no new field on the persisted entries.

### `/mcp` slash command

Adds a new entry to the REPL's slash command list (currently `/plan`, `/clear`, `/exit`):

```
/mcp                         # equivalent to `opencli mcp list` but in-session
/mcp test <name>             # re-probe one server without leaving the REPL
```

Same code as the CLI subcommand, output rendered through the existing renderer.

---

## Failure modes

| Failure | Detection point | Behaviour |
|---|---|---|
| `mcp.json` absent | `loadMcpConfig()` | Returns `null`; no MCP tools registered; no warning |
| `mcp.json` malformed JSON | `loadMcpConfig()` | Logs warning to stderr; returns `null` |
| Server subprocess not found | `McpClient.connect()` | `Promise.allSettled` catches; server skipped with warning |
| Server crashes after connect | `McpClient.callTool()` | SDK throws; `callTool` returns `{ success: false, error: "..." }` |
| Tool call timeout | `AbortSignal.timeout()` | Returns `{ success: false, error: "MCP tool call timed out after 30s" }` |
| Server name collision with built-in | `mcpToolToTool()` | `mcp__<server>__<tool>` namespace prevents collision with built-ins (`read`, `write`, etc.) |
| Two server names sanitise to the same string | `McpManager.create()` | **Hard error at load time** — the second offender is skipped with a stderr message naming both. Silent overwrite would be dangerous (calls go to the wrong server). |
| Two tools from the same server have the same name | MCP server side | The MCP SDK forbids this on the server. Not OpenCLI's concern. |
| Non-text content in tool result | `McpClient.callTool()` | Dropped; appends `"[image/binary content omitted]"` note to output |
| SIGINT during tool call | In-flight SDK request | `AbortSignal.timeout` is the backstop; the subprocess may be left in a dirty state. Known limitation — documented. |

---

## Migration plan

### Existing code — no changes required

The `ToolRegistry`, `executor.ts`, `agent.ts`, and `createDefaultRegistry` are unchanged. MCP tools are just `Tool` objects registered by the CLI layer. The agent loop has no knowledge of the MCP layer.

### `cli/index.ts` changes

Add after existing registry creation:

```typescript
const mcpConfig = await loadMcpConfig(AGENT_DIR);
let mcpManager: McpManager | null = null;
if (mcpConfig && Object.keys(mcpConfig.mcpServers).length > 0) {
  process.stderr.write(`[mcp] connecting to ${Object.keys(mcpConfig.mcpServers).length} server(s)...\n`);
  mcpManager = await McpManager.create(mcpConfig);
  await mcpManager.registerTools(registry);
  if (mcpManager.connectedCount > 0) {
    process.stderr.write(`[mcp] ${mcpManager.connectedCount} server(s) connected\n`);
  }
}

// Centralised shutdown — async-safe.
const shutdown = async (code: number): Promise<void> => {
  try {
    await mcpManager?.disconnectAll();
  } catch (err) {
    process.stderr.write(`[mcp] disconnect error: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.exit(code);
};
process.on("SIGINT", () => void shutdown(130));
process.on("SIGTERM", () => void shutdown(143));
```

**Why not `process.on("exit", ...)`** — the `exit` event is synchronous; the event loop is winding down and any returned `Promise` from `disconnectAll()` is silently discarded. The result is leaked stdio subprocesses on every clean exit. SIGINT/SIGTERM run on a live event loop and can await async cleanup.

#### Ancillary change to `src/cli/input.ts`

Two existing `process.exit(0)` call sites (Ctrl+D handling and the `/exit` command) bypass the new shutdown handler. Inject the `shutdown` callback as a constructor arg / option on the input handler so those paths also flow through `disconnectAll()`. The simplest plumbing:

1. `cli/index.ts` constructs the input handler with `{ onExit: () => shutdown(0) }`.
2. `cli/input.ts` calls `opts.onExit()` instead of `process.exit(0)`.

This is a 2-line change in `input.ts` plus passing the option in `index.ts`. Without it, Ctrl+D leaks stdio subprocesses just like `process.on("exit")` would.

### `state/config.ts` — no changes

MCP server configuration lives in `~/.opencli/mcp.json` (a separate file, not part of `Config`). This keeps the main config small and matches the established practice in Claude Desktop and Codex CLI. A future `opencli mcp add <name> <command>` CLI command can write this file, but that is out of scope for A2.

### `src/skills/registry.ts` — skill catalog update

When MCP tools are loaded, the skill catalog injected into the agent's system prompt will not list them (the catalog is assembled from `SkillRegistry`, not `ToolRegistry`). This is correct — MCP tools appear in the `ToolDefinition[]` sent to the LLM just like built-in tools. No change needed.

### `package.json`

Add to `dependencies`:

```json
"@modelcontextprotocol/sdk": "^1.29.0"
```

---

## Test strategy

| Test | File | What it proves |
|---|---|---|
| `loadMcpConfig`: absent file → null | `mcp/config.test.ts` | Missing file handled gracefully |
| `loadMcpConfig`: malformed JSON → null + warning | same | Parse failure handled |
| `loadMcpConfig`: `${VAR}` expansion (braced only) | same | Env vars substituted; unset var → `""` + warning |
| `loadMcpConfig`: bare `$VAR` left as literal | same | No surprise expansion (Q3 caveat) |
| `loadMcpConfig`: `$${` → literal `${` | same | Escape sequence works |
| `loadMcpConfig`: no `transport` field defaults to stdio | same | Backward compat with Claude Desktop format |
| `loadMcpConfig`: per-server `callTimeout` parsed | same | Q6 wiring |
| `mcpToolToTool`: name format `mcp__server__tool` | `mcp/adapter.test.ts` | Naming convention |
| `mcpToolToTool`: `readonly = false` | same | Plan-mode blocking wired up |
| `mcpToolToTool`: `truncateOutput = true` | same | Large outputs are truncated |
| `mcpToolToTool`: `requiresConfirmation() = true` | same | HITL gate always fires |
| `mcpToolToTool`: description prefixed with `[server]` | same | UX clarity |
| `McpClient.callTool`: text content → `{ success: true, output }` | `mcp/client.test.ts` | Happy path |
| `McpClient.callTool`: `isError: true` → `{ success: false }` | same | Error propagation |
| `McpClient.callTool`: image content dropped with `[N non-text content block(s) omitted]` note | same | Non-text handling |
| `McpClient.callTool`: timeout → `{ success: false, error: "...timed out..." }` | same | AbortError caught by try/catch |
| `McpClient.callTool`: transport error caught (no unhandled rejection) | same | try/catch covers SDK throws |
| `McpClient`: per-server `callTimeout` overrides global default | same | Q6 behaviour |
| `McpManager.create`: one server fails → others still load | `mcp/manager.test.ts` | Partial failure isolation |
| `McpManager.create`: name sanitisation logs once per server, not per tool | same | Per-server warning, not per-tool |
| `McpManager.create`: collision after sanitisation → second server skipped + stderr | same | Hard collision error |
| `McpManager.create`: name from entries is carried through (not indexed) | same | Index fragility fix |
| `McpManager.registerTools`: tools appear in registry | same | Registry integration |
| `McpManager.registerTools`: `listTools` failure isolated to that server | same | One bad server doesn't block others |
| `McpManager.disconnectAll`: stdio subprocess terminates | same | No leaked processes |
| Executor truncates output when `tool.truncateOutput === true` | `core/executor.test.ts` (update existing cases) | Migration of TRUNCATE_TOOLS Set |
| Executor routes `mcp__*__*` tool through HITL | same (add cases) | End-to-end HITL for MCP tool |
| CLI `SIGINT` handler awaits `disconnectAll` before exit | `cli/index.test.ts` (add) | Async shutdown works |
| `opencli mcp add` one-shot writes valid JSON to mcp.json | `cli/mcp-cmd.test.ts` | Subcommand round-trip |
| `opencli mcp add` rejects invalid server names (would require sanitisation) | same | Catches collisions before runtime |
| `opencli mcp add --force` overrides existing entry | same | Overwrite path |
| `opencli mcp list` shows all configured servers with probe status | same | Status column populates |
| `opencli mcp list --no-probe` skips connection check | same | Faster path for scripts |
| `opencli mcp test` exits 0 on connect, 1 on failure | same | CI suitability |
| `opencli mcp remove` removes the entry | same | Removal works |
| HITL prompt: `t` choice persists `tool:*` allow-list key | `cli/repl.test.ts` (add) | Tool-wildcard allow |
| HITL prompt: `s` choice persists `mcp__<server>__*` allow-list key | same | Server-wildcard allow |
| HITL prompt: `t`/`s` choices hidden for non-MCP tools | same | Conditional rendering |
| Allow-list matcher: exact → tool-wildcard → server-wildcard order | same | Match precedence |
| `/mcp` slash command renders the same as `opencli mcp list` | same | REPL parity |

**Test infrastructure:** Use an in-process mock MCP server (the SDK ships a `Server` class) rather than spawning real npm packages. This makes tests fast, deterministic, and self-contained.

```typescript
// Example: in-process mock server for tests
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const mockServer = new Server({ name: "test", version: "0.0.1" });
mockServer.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: [{ name: "echo", description: "Echo input", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }],
}));
mockServer.setRequestHandler(CallToolRequestSchema, (req) => ({
  content: [{ type: "text", text: req.params.arguments?.text ?? "" }],
}));
await mockServer.connect(serverTransport);
// Pass clientTransport to McpClient instead of a real transport
```

---

## Open questions

**Q1 — Transport field backward compat. _(answered: default to `"stdio"`)_**
Claude Desktop's `claude_desktop_config.json` has no `transport` key — it implicitly means stdio. If a user copies their Claude Desktop config directly, we must not reject it. The design treats absent `transport` as `"stdio"`. Documented in README.

**Q2 — Startup latency. _(answered: eager + progress message)_**
Connecting all MCP servers at startup adds latency before the REPL prompt appears. With a slow server (e.g. one that runs `npx -y ...` and downloads packages on first run), this can be several seconds. The CLI emits `[mcp] connecting to N server(s)...` before the connect calls so users see progress, then `[mcp] N server(s) connected` after. Lazy connect is a follow-on if startup latency becomes a real complaint.

**Q3 — `${VAR}` expansion at load time, `${...}` only. _(answered)_**
Expand at load time for A2 — most tokens are long-lived. Only the braced form `${VAR}` is recognised; bare `$VAR` is left as a literal to avoid accidental expansion of strings (paths, tokens) users did not intend to substitute. `$${` escapes a literal `${`. Per-request token refresh for short-lived OAuth tokens is split out as Q5.

**Q4 — `opencli mcp` subcommand. _(answered: ship with A2 — see "User-facing CLI surface")_**
The original recommendation was to defer. Reversed: shipping the protocol layer without `add`/`list`/`test`/`remove` produces a feature that's invisible until users trip over it, contradicts the project's "open + ergonomic" positioning, and only saves ~200-300 LOC of CLI scaffolding. A2 ships the four subcommands plus the `/mcp` REPL command and the per-server HITL allow option.

**Q5 — Per-request token refresh for short-lived OAuth tokens. _(open)_**
Some HTTP MCP servers use OAuth-issued tokens with TTLs of minutes. Load-time expansion captures the token at startup; the connection then breaks when the token expires mid-session. Options:

- (a) Re-expand on every HTTP request (cheap, but the load-time captured value is the same as the runtime value unless something else refreshes the env var).
- (b) Hook in a token-refresh callback per server: `headers: { Authorization: "Bearer ${GITHUB_TOKEN}" }` plus an optional `refreshCommand: "gh auth token"` that's executed before each request when the token is close to expiry.
- (c) Defer entirely to a follow-up — most users will rely on long-lived PATs for A2.

_Recommendation: defer (option c) for A2, document the limitation. Revisit if a real user reports an expired-token failure._

**Q6 — Per-server `callTimeout` in `mcp.json`. _(open, recommend yes)_**
Different servers have different latency profiles. A local filesystem server should time out in 5s; a slow database query MCP server might need 120s. The current `McpClientOpts` only allows a global default.

_Recommendation: add an optional `callTimeout?: number` (milliseconds) field to `McpServerConfig`. The `McpClient` uses the per-server value when present, otherwise falls back to the `McpClientOpts.callTimeout` default. This is a 5-line addition and avoids a follow-up PR. Default global timeout: 30 000 ms._

```jsonc
{
  "mcpServers": {
    "filesystem": { "transport": "stdio", "command": "...", "callTimeout": 5000 },
    "slow-db":    { "transport": "stdio", "command": "...", "callTimeout": 120000 }
  }
}
```

---

## File change summary

| Action | File |
|---|---|
| Create | `src/mcp/types.ts` |
| Create | `src/mcp/client.ts` |
| Create | `src/mcp/adapter.ts` |
| Create | `src/mcp/manager.ts` |
| Create | `src/mcp/config.ts` |
| Create | `src/mcp/index.ts` |
| Create | `src/mcp/config.test.ts` |
| Create | `src/mcp/client.test.ts` |
| Create | `src/mcp/adapter.test.ts` |
| Create | `src/mcp/manager.test.ts` |
| Modify | `src/tools/base.ts` — add `truncateOutput?: boolean` to `Tool` interface |
| Modify | `src/tools/exec/bash.ts` — set `truncateOutput: true` |
| Modify | `src/tools/file/grep.ts` — set `truncateOutput: true` |
| Modify | `src/tools/file/glob.ts` — set `truncateOutput: true` |
| Modify | `src/core/executor.ts` — replace `TRUNCATE_TOOLS` Set with `tool?.truncateOutput` lookup |
| Modify | `src/core/executor.test.ts` — update truncation cases to drive off the flag; add HITL cases for `mcp__*__*` tools |
| Modify | `src/cli/index.ts` — load mcp.json, create McpManager, register tools, register async SIGINT/SIGTERM shutdown, register `mcp` subcommand |
| Modify | `src/cli/input.ts` — accept `onExit` callback; replace bare `process.exit(0)` calls |
| Modify | `src/cli/repl.ts` — extend HITL prompt with `t`/`s` choices for MCP tools; add `/mcp` slash command |
| Create | `src/cli/mcp-cmd.ts` — `add`/`list`/`test`/`remove` subcommands; shared `probeServer` and `writeMcpConfig` helpers |
| Create | `src/cli/mcp-cmd.test.ts` — subcommand tests using in-process `InMemoryTransport` |
| Modify | `package.json` — add `@modelcontextprotocol/sdk ^1.x` dependency |
| Update | `README.md` — document `~/.opencli/mcp.json` format, `${VAR}` expansion rules, `mcp__server__tool` naming, per-server `callTimeout`, the `opencli mcp` subcommand suite |
| Update | `docs/architecture.md` — add `src/mcp/` to source tree; note MCP as a fourth tool surface; note `Tool.truncateOutput` flag; document `opencli mcp` subcommands |
