import type { Command } from "commander";
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import chalk from "chalk";
import * as clack from "@clack/prompts";
import { AGENT_DIR } from "../state/config.js";
import { McpClient } from "../mcp/client.js";
import { loadMcpConfig } from "../mcp/config.js";
import type { McpConfig, McpServerConfig } from "../mcp/types.js";

// ── Shared helpers ────────────────────────────────────────────────────────────

export interface ProbeResult {
  ok: boolean;
  tools?: string[];
  error?: string;
  latencyMs?: number;
}

export async function probeServer(name: string, config: McpServerConfig): Promise<ProbeResult> {
  const client = new McpClient(name, config);
  const start = Date.now();
  try {
    await client.connect();
    const tools = await client.listTools();
    await client.close();
    return { ok: true, tools: tools.map((t) => t.name), latencyMs: Date.now() - start };
  } catch (err) {
    try {
      await client.close();
    } catch {
      // ignore close errors
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function writeMcpConfig(updater: (current: McpConfig) => McpConfig): Promise<void> {
  await mkdir(AGENT_DIR, { recursive: true });
  const configPath = join(AGENT_DIR, "mcp.json");

  let current: McpConfig = { mcpServers: {} };
  try {
    const raw = await readFile(configPath, "utf8");
    current = JSON.parse(raw) as McpConfig;
  } catch {
    // file absent or unparseable — start fresh
  }

  const updated = updater(current);
  const tmp = join(AGENT_DIR, `mcp.json.tmp-${randomUUID()}`);
  await writeFile(tmp, JSON.stringify(updated, null, 2) + "\n", "utf8");
  await rename(tmp, configPath);
}

// ── `opencli mcp add` ─────────────────────────────────────────────────────────

async function mcpAdd(
  nameArg: string | undefined,
  rest: string[],
  opts: {
    transport?: string;
    url?: string;
    header?: string[];
    force?: boolean;
  },
): Promise<void> {
  const currentConfig = await loadMcpConfig(AGENT_DIR);
  const currentServers = currentConfig?.mcpServers ?? {};

  let name: string;
  let serverConfig: McpServerConfig;

  if (nameArg && rest.length > 0) {
    // One-shot form: opencli mcp add <name> -- <command> [args...]
    name = nameArg;
    const transport = (opts.transport as "stdio" | "http" | undefined) ?? "stdio";
    if (transport === "http") {
      const url = opts.url ?? rest[0];
      serverConfig = { transport: "http", url };
    } else {
      serverConfig = { transport: "stdio", command: rest[0], args: rest.slice(1) };
    }
  } else if (nameArg && opts.transport === "http" && opts.url) {
    name = nameArg;
    const headers: Record<string, string> = {};
    for (const h of opts.header ?? []) {
      const idx = h.indexOf(":");
      if (idx !== -1) {
        headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
      }
    }
    serverConfig = {
      transport: "http",
      url: opts.url,
      headers: Object.keys(headers).length > 0 ? headers : undefined,
    };
  } else {
    // Interactive form
    process.stdout.write("\n");
    const _name = await clack.text({ message: "Server name", placeholder: "filesystem" });
    if (clack.isCancel(_name)) {
      process.stdout.write("Cancelled.\n");
      return;
    }
    name = _name as string;

    const _transport = await clack.select({
      message: "Transport",
      options: [
        { value: "stdio", label: "stdio (subprocess)" },
        { value: "http", label: "http (Streamable HTTP / SSE)" },
      ],
    });
    if (clack.isCancel(_transport)) {
      process.stdout.write("Cancelled.\n");
      return;
    }

    if (_transport === "http") {
      const _url = await clack.text({ message: "URL", placeholder: "http://localhost:3000/mcp" });
      if (clack.isCancel(_url)) return;
      serverConfig = { transport: "http", url: _url as string };
    } else {
      const _command = await clack.text({ message: "Command", placeholder: "npx" });
      if (clack.isCancel(_command)) return;
      const _argsRaw = await clack.text({
        message: "Args (space-separated)",
        placeholder: "-y @modelcontextprotocol/server-filesystem /tmp",
        initialValue: "",
      });
      if (clack.isCancel(_argsRaw)) return;
      const args = (_argsRaw as string).trim().split(/\s+/).filter(Boolean);
      serverConfig = {
        transport: "stdio",
        command: _command as string,
        args: args.length > 0 ? args : undefined,
      };
    }
  }

  // Validate name
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
    process.stderr.write(
      `Error: server name '${name}' contains invalid characters. Use [a-zA-Z0-9_-] only.\n`,
    );
    process.exit(1);
  }

  if (currentServers[name] && !opts.force) {
    process.stderr.write(`Error: server '${name}' already exists. Use --force to overwrite.\n`);
    process.exit(1);
  }

  process.stdout.write(`[mcp] connecting to ${name}...\n`);
  const probe = await probeServer(name, serverConfig);
  if (probe.ok) {
    process.stdout.write(
      chalk.green(`[mcp] ✓ connected — ${probe.tools!.length} tools: ${probe.tools!.join(", ")}\n`),
    );
  } else {
    process.stdout.write(chalk.yellow(`[mcp] ✗ connection failed: ${probe.error}\n`));
    const _saveAnyway = await clack.confirm({
      message: "Save anyway?",
      initialValue: false,
    });
    if (clack.isCancel(_saveAnyway) || !_saveAnyway) {
      process.stdout.write("Aborted.\n");
      return;
    }
  }

  await writeMcpConfig((cfg) => ({
    mcpServers: { ...cfg.mcpServers, [name]: serverConfig },
  }));
  process.stdout.write(`[mcp] saved to ${join(AGENT_DIR, "mcp.json")}\n`);
}

// ── `opencli mcp list` ────────────────────────────────────────────────────────

async function mcpList(opts: { noProbe?: boolean }): Promise<void> {
  const config = await loadMcpConfig(AGENT_DIR);
  if (!config || Object.keys(config.mcpServers).length === 0) {
    process.stdout.write("No MCP servers configured. Run `opencli mcp add` to add one.\n");
    return;
  }

  const entries = Object.entries(config.mcpServers);

  let probeResults: Map<string, ProbeResult> | null = null;
  if (!opts.noProbe) {
    const results = await Promise.allSettled(
      entries.map(async ([name, cfg]) => ({ name, result: await probeServer(name, cfg) })),
    );
    probeResults = new Map(
      results
        .filter((r) => r.status === "fulfilled")
        .map((r) => {
          const { name, result } = (
            r as PromiseFulfilledResult<{ name: string; result: ProbeResult }>
          ).value;
          return [name, result] as [string, ProbeResult];
        }),
    );
  }

  const nameW = 16,
    transportW = 10,
    statusW = 10;
  const header =
    "NAME".padEnd(nameW) + "TRANSPORT".padEnd(transportW) + "STATUS".padEnd(statusW) + "TOOLS";
  process.stdout.write(chalk.bold(header) + "\n");
  process.stdout.write("─".repeat(60) + "\n");

  for (const [name, cfg] of entries) {
    const transport = cfg.transport;
    const probe = probeResults?.get(name);
    let status: string;
    let tools: string;

    if (!probeResults) {
      status = "—";
      tools = "—";
    } else if (probe?.ok) {
      status = chalk.green("ok");
      tools =
        probe.tools!.length <= 3
          ? probe.tools!.join(", ")
          : `${probe.tools!.length} (${probe.tools!.slice(0, 3).join(", ")}, ...)`;
    } else {
      status = chalk.red("error");
      tools = "—";
    }

    process.stdout.write(
      name.padEnd(nameW) + transport.padEnd(transportW) + status.padEnd(statusW) + tools + "\n",
    );
  }
}

// ── `opencli mcp test` ────────────────────────────────────────────────────────

async function mcpTest(name: string): Promise<void> {
  const config = await loadMcpConfig(AGENT_DIR);
  const serverConfig = config?.mcpServers[name];
  if (!serverConfig) {
    process.stderr.write(`Error: no server named '${name}' in mcp.json.\n`);
    process.exit(1);
  }

  process.stdout.write(`[mcp] connecting to ${name}...\n`);
  const probe = await probeServer(name, serverConfig);
  if (probe.ok) {
    process.stdout.write(
      chalk.green(`[mcp] ✓ ok — ${probe.tools!.length} tools advertised in ${probe.latencyMs}ms\n`),
    );
    for (const t of probe.tools!) {
      process.stdout.write(`       • ${t}\n`);
    }
    process.exit(0);
  } else {
    process.stderr.write(chalk.red(`[mcp] ✗ failed: ${probe.error}\n`));
    process.exit(1);
  }
}

// ── `opencli mcp remove` ─────────────────────────────────────────────────────

async function mcpRemove(name: string, opts: { yes?: boolean }): Promise<void> {
  const config = await loadMcpConfig(AGENT_DIR);
  if (!config?.mcpServers[name]) {
    process.stderr.write(`Error: no server named '${name}' in mcp.json.\n`);
    process.exit(1);
  }

  if (!opts.yes) {
    const confirm = await clack.confirm({
      message: `Remove '${name}' from ${join(AGENT_DIR, "mcp.json")}?`,
      initialValue: false,
    });
    if (clack.isCancel(confirm) || !confirm) {
      process.stdout.write("Cancelled.\n");
      return;
    }
  }

  await writeMcpConfig((cfg) => ({
    mcpServers: Object.fromEntries(Object.entries(cfg.mcpServers).filter(([k]) => k !== name)),
  }));
  process.stdout.write(`Removed '${name}'.\n`);
}

// ── Register subcommands on the commander instance ───────────────────────────

export function registerMcpCommand(program: Command): void {
  const mcp = program.command("mcp").description("Manage MCP server connections");

  mcp
    .command("add [name] [rest...]")
    .description("Add an MCP server to ~/.opencli/mcp.json")
    .option("--transport <transport>", "Transport type: stdio | http (default: stdio)")
    .option("--url <url>", "Server URL (http transport)")
    .option("--header <header...>", 'Header in "Key: Value" format (http transport)')
    .option("--force", "Overwrite existing entry")
    .action(async (name: string | undefined, rest: string[], opts) => {
      await mcpAdd(
        name,
        rest,
        opts as { transport?: string; url?: string; header?: string[]; force?: boolean },
      );
    });

  mcp
    .command("list")
    .description("List configured MCP servers and their status")
    .option("--no-probe", "Skip connection probe (faster, good for scripts)")
    .action(async (opts) => {
      await mcpList({ noProbe: !(opts as { probe: boolean }).probe });
    });

  mcp
    .command("test <name>")
    .description("Test connection to a configured MCP server")
    .action(async (name: string) => {
      await mcpTest(name);
    });

  mcp
    .command("remove <name>")
    .description("Remove an MCP server from ~/.opencli/mcp.json")
    .option("-y, --yes", "Skip confirmation prompt")
    .action(async (name: string, opts) => {
      await mcpRemove(name, opts as { yes?: boolean });
    });
}
