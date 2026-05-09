# Design: A2 — MCP client

_Status: Ready for implementation. Tracking issue: to be opened. Phase: [Roadmap A2](../roadmap.md)._

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

**Variable expansion:** `${VAR}` references in string values are expanded against `process.env` at load time. Expansion is limited to string values only — no recursive expansion, no shell metacharacters. Unset variables become empty strings with a startup warning.

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
const transport =
  config.transport === "http"
    ? new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } })
    : new StdioClientTransport({ command: config.command, args: config.args, env: resolvedEnv });

this.sdkClient = new Client({ name: "opencli", version: "0.1.0" });
await this.sdkClient.connect(transport);
```

For `callTool()`, wrap the SDK result into `ToolResult`:

```typescript
async callTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
  const result = await this.sdkClient.callTool(
    { name: toolName, arguments: args },
    undefined,
    { signal: AbortSignal.timeout(this.callTimeout) },
  );
  const output = result.content
    .filter((c) => c.type === "text")
    .map((c) => (c as { type: "text"; text: string }).text)
    .join("\n");
  return result.isError
    ? { success: false, output, error: output || "MCP tool returned an error" }
    : { success: true, output };
}
```

Image/blob content blocks are dropped with a one-line note appended to `output`. Non-text content can be added in a follow-on PR when there's a concrete use case.

### `adapter.ts`

```typescript
import type { Tool } from "../tools/base.js";
import type { McpClient } from "./client.js";
import type { McpToolInfo } from "./types.js";

/**
 * Bridges one MCP tool into an OpenCLI Tool.
 *
 * Tool name format: mcp__<serverName>__<toolName>
 * (double-underscore, matching Claude Code's convention for compatibility)
 *
 * All MCP tools require HITL confirmation — the user chose to install the
 * server but did not pre-approve every individual call. Allow-listing a
 * specific tool by name persists to .opencli/settings.json via the standard
 * HITL flow with no special handling needed here.
 *
 * MCP tools are write tools (readonly = false) — they are blocked in plan mode.
 */
export function mcpToolToTool(client: McpClient, info: McpToolInfo): Tool {
  const toolName = `mcp__${client.serverName}__${info.name}`;
  return {
    name: toolName,
    description: `[${client.serverName}] ${info.description}`,
    parameters: info.inputSchema as Tool["parameters"],
    readonly: false,
    requiresConfirmation: () => true,
    execute: (params) => client.callTool(info.name, params),
  };
}
```

**Name sanitisation:** server names are sanitised to `[a-zA-Z0-9_-]` (non-matching chars replaced with `_`) before use in the compound tool name. A warning is logged if sanitisation changed the name.

### `manager.ts`

```typescript
export class McpManager {
  constructor(private clients: McpClient[]) {}

  /** Connect all servers concurrently. Failed servers are logged but do not abort startup. */
  static async create(config: McpConfig, opts?: McpClientOpts): Promise<McpManager>;

  /** Register all successfully-connected servers' tools into the given registry. */
  registerTools(registry: ToolRegistry): void;

  /** Close all connections. Called on CLI exit (SIGINT/SIGTERM). */
  async disconnectAll(): Promise<void>;

  /** Number of servers that connected successfully. */
  get connectedCount(): number;
}
```

#### `McpManager.create()` — startup flow

```typescript
static async create(config: McpConfig, opts?: McpClientOpts): Promise<McpManager> {
  const results = await Promise.allSettled(
    Object.entries(config.mcpServers).map(async ([name, serverConfig]) => {
      const client = new McpClient(name, serverConfig, opts);
      await client.connect();  // throws on failure
      return client;
    }),
  );

  const clients: McpClient[] = [];
  for (const [i, result] of results.entries()) {
    const name = Object.keys(config.mcpServers)[i];
    if (result.status === "fulfilled") {
      clients.push(result.value);
    } else {
      process.stderr.write(`[mcp] ${name}: failed to connect — ${result.reason}\n`);
    }
  }
  return new McpManager(clients);
}
```

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

## Failure modes

| Failure | Detection point | Behaviour |
|---|---|---|
| `mcp.json` absent | `loadMcpConfig()` | Returns `null`; no MCP tools registered; no warning |
| `mcp.json` malformed JSON | `loadMcpConfig()` | Logs warning to stderr; returns `null` |
| Server subprocess not found | `McpClient.connect()` | `Promise.allSettled` catches; server skipped with warning |
| Server crashes after connect | `McpClient.callTool()` | SDK throws; `callTool` returns `{ success: false, error: "..." }` |
| Tool call timeout | `AbortSignal.timeout()` | Returns `{ success: false, error: "MCP tool call timed out after 30s" }` |
| Server name collision with built-in | `mcpToolToTool()` | `mcp__<server>__<tool>` namespace prevents collision with built-ins (`read`, `write`, etc.) |
| Two servers advertise same tool name | `manager.registerTools()` | Last-registered wins (registry overwrites). Log a warning naming both servers. |
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
  mcpManager = await McpManager.create(mcpConfig);
  mcpManager.registerTools(registry);
  if (mcpManager.connectedCount > 0) {
    process.stderr.write(`[mcp] ${mcpManager.connectedCount} server(s) connected\n`);
  }
}
process.on("exit", () => { mcpManager?.disconnectAll(); });
```

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
| `loadMcpConfig`: `${VAR}` expansion | same | Env vars substituted; unset var → `""` + warning |
| `loadMcpConfig`: no `transport` field defaults to stdio | same | Backward compat with Claude Desktop format |
| `mcpToolToTool`: name format `mcp__server__tool` | `mcp/adapter.test.ts` | Naming convention |
| `mcpToolToTool`: `readonly = false` | same | Plan-mode blocking wired up |
| `mcpToolToTool`: `requiresConfirmation() = true` | same | HITL gate always fires |
| `mcpToolToTool`: description prefixed with `[server]` | same | UX clarity |
| `McpClient.callTool`: text content → `{ success: true, output }` | `mcp/client.test.ts` | Happy path |
| `McpClient.callTool`: `isError: true` → `{ success: false }` | same | Error propagation |
| `McpClient.callTool`: image content dropped with note | same | Non-text handling |
| `McpClient.callTool`: timeout → `{ success: false, error: "...timed out..." }` | same | Timeout guard |
| `McpManager.create`: one server fails → others still load | `mcp/manager.test.ts` | Partial failure isolation |
| `McpManager.registerTools`: tools appear in registry | same | Registry integration |
| Name collision warning logged | same | Collision detection |
| Executor routes `mcp__*__*` tool through HITL | `core/executor.test.ts` (add cases) | End-to-end HITL for MCP tool |

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

**Q1 — Transport field backward compat.**
Claude Desktop's `claude_desktop_config.json` has no `transport` key — it implicitly means stdio. If a user copies their Claude Desktop config directly, we must not reject it. The design treats absent `transport` as `"stdio"`. Is this the right default, or should we require the field explicitly to avoid surprises?
_Recommendation: default to `"stdio"` for compat. Document the accepted formats in README._

**Q2 — Startup latency.**
Connecting all MCP servers at startup adds latency before the REPL prompt appears. With a slow server (e.g. one that runs `npx -y ...` and downloads packages on first run), this can be several seconds. Should connection be lazy (on first tool use) or eager (at startup)?
_Recommendation: eager for A2 (simpler; user knows which servers are configured). Add lazy option in a follow-on if startup latency becomes a real complaint. Surface the `[mcp] N server(s) connected` message early so the user knows what's happening._

**Q3 — HTTP transport auth and `${VAR}` expansion.**
The `headers` field in HTTP servers often contains tokens (`Authorization: Bearer ${GITHUB_TOKEN}`). Variable expansion at load time means the token is read from env at startup. Is this the right place for expansion, or should it happen per-request (to support dynamic tokens)?
_Recommendation: expand at load time for A2. Dynamic token refresh is an edge case — most tokens are long-lived. Note the limitation in docs._

**Q4 — `opencli mcp` subcommand.**
Should A2 ship a `opencli mcp list` command (shows configured servers and their tool counts) and `opencli mcp add <name> <command> [args...]` (writes to `mcp.json`)? These are QoL features but not required for the core integration.
_Recommendation: defer to a follow-on. A2 ships the client integration only; users edit `mcp.json` manually. Document the format in README._

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
| Modify | `src/cli/index.ts` — load mcp.json, create McpManager, register tools, hook disconnectAll on exit |
| Modify | `src/core/executor.test.ts` — add HITL cases for `mcp__*__*` tool names |
| Modify | `package.json` — add `@modelcontextprotocol/sdk` dependency |
| Update | `README.md` — document `~/.opencli/mcp.json` format and `mcp__server__tool` naming |
| Update | `docs/architecture.md` — add `src/mcp/` to source tree; note MCP as a fourth tool surface |
