import { Command } from "commander";
import { createClient, detectProvider } from "../providers/factory.js";
import { Agent } from "../core/agent.js";
import { createDefaultRegistry } from "../tools/index.js";
import { SkillRegistry } from "../skills/registry.js";
import { loadConfig, saveConfig, AGENT_DIR } from "../state/config.js";
import { Session } from "../state/session.js";
import { loadSystemInstruction } from "../core/prompt.js";
import { resolveApiKey } from "./keys.js";
import { runRepl, createConfirmFn } from "./repl.js";
import { printError, printInfo } from "./renderer.js";
import type { ObservabilityEvent } from "../core/observability.js";
import { createSandboxRunner } from "../tools/exec/sandbox/index.js";
import type { SandboxMode } from "../tools/exec/sandbox/types.js";
import type { Config } from "../state/config.js";
import { loadMcpConfig } from "../mcp/config.js";
import { McpManager } from "../mcp/manager.js";
import { registerMcpCommand } from "./mcp-cmd.js";

const program = new Command();

program
  .name("opencli")
  .description("An open-source AI agent CLI — supports Gemini and Claude models")
  .version("0.1.0");

program
  .command("chat", { isDefault: true })
  .description("Start an interactive chat session")
  .option(
    "-m, --model <model>",
    "Model to use (e.g. gemini-3.1-flash-lite-preview, claude-sonnet-4-6)",
  )
  .option("-r, --resume", "Resume the most recent session")
  .option("-s, --session <id>", "Resume a specific session by ID")
  .option("--max-turns <n>", "Maximum agent iterations per prompt (default: 50)", parseInt)
  .option("--debug", "Emit structured observability events to stderr as JSON")
  .option("--sandbox <mode>", "Sandbox mode for bash tool: auto | strict | off (default: auto)")
  .option("--provider <provider>", "Override provider detection: gemini | anthropic | openai")
  .option("--base-url <url>", "Custom base URL for proxy or local inference (e.g. LiteLLM)")
  .action(async (opts) => {
    const sessionId = opts.session ?? (opts.resume ? "latest" : undefined);
    await startChat(
      opts.model,
      sessionId,
      opts.maxTurns,
      opts.debug as boolean | undefined,
      opts.sandbox as string | undefined,
      opts.provider as string | undefined,
      opts.baseUrl as string | undefined,
    );
  });

program
  .command("sessions")
  .description("List recent sessions for the current directory")
  .action(async () => {
    const sessions = await Session.list();
    if (sessions.length === 0) {
      printInfo("No sessions found for this directory.");
      return;
    }
    printInfo(`Sessions for ${process.cwd()}:\n`);
    for (const s of sessions) {
      const preview = s.firstUserMessage ? `  "${s.firstUserMessage}"` : "";
      process.stderr.write(`  ${s.id}${preview ? `\n  ${preview}` : ""}\n\n`);
    }
  });

program
  .command("run <prompt>")
  .description("Run a single prompt and exit")
  .option("-m, --model <model>", "Model to use")
  .option("--max-turns <n>", "Maximum agent iterations (default: 50)", parseInt)
  .option("--plan", "Run a read-only planning pass first, then auto-execute the plan")
  .option("--yes", "Auto-approve all tool confirmations (skip interactive prompts)")
  .option("--debug", "Emit structured observability events to stderr as JSON")
  .option("--sandbox <mode>", "Sandbox mode for bash tool: auto | strict | off (default: auto)")
  .option("--provider <provider>", "Override provider detection: gemini | anthropic | openai")
  .option("--base-url <url>", "Custom base URL for proxy or local inference (e.g. LiteLLM)")
  .action(async (prompt: string, opts) => {
    await runSingle(
      prompt,
      opts.model,
      opts.maxTurns,
      opts.plan as boolean | undefined,
      opts.yes as boolean | undefined,
      opts.debug as boolean | undefined,
      opts.sandbox as string | undefined,
      opts.provider as string | undefined,
      opts.baseUrl as string | undefined,
    );
  });

program
  .command("config")
  .description("View or set configuration")
  .option("--gemini-api-key <key>", "Set your Gemini API key")
  .option("--anthropic-api-key <key>", "Set your Anthropic API key")
  .option("--openai-api-key <key>", "Set your OpenAI API key")
  .option("--model <model>", "Set the default model")
  .option("--provider <provider>", "Set the default provider: gemini | anthropic | openai")
  .option("--base-url <url>", "Set a custom base URL for proxy or local inference")
  .action(async (opts) => {
    if (opts.geminiApiKey) {
      await saveConfig({ geminiApiKey: opts.geminiApiKey });
      printInfo("Gemini API key saved.");
    }
    if (opts.anthropicApiKey) {
      await saveConfig({ anthropicApiKey: opts.anthropicApiKey });
      printInfo("Anthropic API key saved.");
    }
    if (opts.openaiApiKey) {
      await saveConfig({ openaiApiKey: opts.openaiApiKey });
      printInfo("OpenAI API key saved.");
    }
    if (opts.model) {
      await saveConfig({ model: opts.model });
      printInfo(`Default model set to ${opts.model}.`);
    }
    if (opts.provider) {
      await saveConfig({ provider: opts.provider as Config["provider"] });
      printInfo(`Default provider set to ${opts.provider}.`);
    }
    if (opts.baseUrl) {
      await saveConfig({ baseUrl: opts.baseUrl });
      printInfo(`Base URL set to ${opts.baseUrl}.`);
    }
    if (
      !opts.geminiApiKey &&
      !opts.anthropicApiKey &&
      !opts.openaiApiKey &&
      !opts.model &&
      !opts.provider &&
      !opts.baseUrl
    ) {
      const config = await loadConfig();
      console.log(
        JSON.stringify(
          {
            ...config,
            geminiApiKey: config.geminiApiKey ? "***" : undefined,
            anthropicApiKey: config.anthropicApiKey ? "***" : undefined,
            openaiApiKey: config.openaiApiKey ? "***" : undefined,
          },
          null,
          2,
        ),
      );
    }
  });

registerMcpCommand(program);

program.parseAsync(process.argv).catch((err) => {
  printError(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

async function startChat(
  modelOverride?: string,
  resumeSessionId?: string,
  maxTurns?: number,
  debug?: boolean,
  sandboxFlag?: string,
  providerOverride?: string,
  baseUrlOverride?: string,
): Promise<void> {
  const { agent, skills, mcpManager } = await createAgent(
    modelOverride,
    maxTurns,
    debug,
    sandboxFlag,
    providerOverride,
    baseUrlOverride,
  );

  const cleanup = async () => {
    await mcpManager.disconnectAll();
  };

  // Ctrl+C in the REPL calls onExit for graceful MCP subprocess shutdown
  const onExit = async () => {
    await cleanup();
    process.exit(0);
  };

  // SIGTERM from the OS (e.g. docker stop, systemd) also needs cleanup
  process.once("SIGTERM", () => void onExit());

  await runRepl(agent, skills, resumeSessionId, onExit);
  await cleanup(); // normal exit (Ctrl+D or /exit)
}

async function runSingle(
  prompt: string,
  modelOverride?: string,
  maxTurns?: number,
  planMode?: boolean,
  autoApprove?: boolean,
  debug?: boolean,
  sandboxFlag?: string,
  providerOverride?: string,
  baseUrlOverride?: string,
): Promise<void> {
  const { agent, mcpManager } = await createAgent(
    modelOverride,
    maxTurns,
    debug,
    sandboxFlag,
    providerOverride,
    baseUrlOverride,
  );
  if (autoApprove) {
    agent.setConfirmFn(async () => "allow");
  } else if (process.stdin.isTTY) {
    agent.setConfirmFn(await createConfirmFn());
  }
  // no confirmFn → executor auto-denies tools that require confirmation

  const stream = async (input: string, mode: "react" | "plan") => {
    let text = "";
    for await (const event of agent.run(input, mode)) {
      if (event.type === "text") {
        process.stdout.write(event.text);
        text += event.text;
      }
      if (event.type === "error") process.stderr.write(`Error: ${event.message}\n`);
      if (event.type === "done") process.stdout.write("\n");
    }
    return text;
  };

  try {
    if (planMode) {
      const planText = await stream(prompt, "plan");
      if (planText.trim()) {
        process.stderr.write("\nExecuting plan…\n");
        await stream(
          `I have approved the following plan. Execute it step by step:\n\n${planText}`,
          "react",
        );
      }
    } else {
      await stream(prompt, "react");
    }
  } finally {
    await mcpManager.disconnectAll();
  }
}

function makeDebugHandler(): (event: ObservabilityEvent) => void {
  return (event) => process.stderr.write(JSON.stringify(event) + "\n");
}

function resolveSandboxMode(flagValue: string | undefined, config: Config): SandboxMode {
  const raw = flagValue ?? process.env.OPENCLI_SANDBOX ?? config.sandbox ?? "auto";
  if (raw === "auto" || raw === "strict" || raw === "off") return raw;
  throw new Error(`Invalid --sandbox value '${raw}'. Valid values: auto, strict, off`);
}

function resolveProvider(
  flag: string | undefined,
  config: Config,
  model: string,
): "gemini" | "anthropic" | "openai" {
  const raw = flag ?? config.provider;
  if (raw !== undefined) {
    if (raw === "gemini" || raw === "anthropic" || raw === "openai") return raw;
    throw new Error(`Invalid --provider value '${raw}'. Valid values: gemini, anthropic, openai`);
  }
  return detectProvider(model);
}

async function createAgent(
  modelOverride?: string,
  maxTurns?: number,
  debug?: boolean,
  sandboxFlag?: string,
  providerOverride?: string,
  baseUrlOverride?: string,
) {
  const config = await loadConfig();
  const model = process.env.OPENCLI_MODEL ?? modelOverride ?? config.model;

  const sandboxMode = resolveSandboxMode(sandboxFlag, config);
  const runner = createSandboxRunner(sandboxMode, process.cwd());
  if (runner.warning) {
    process.stderr.write(`[opencli] warn: ${runner.warning}\n`);
  }

  const provider = resolveProvider(providerOverride, config, model);
  const baseUrl = baseUrlOverride ?? config.baseUrl;
  const apiKey = resolveApiKey(provider, config);
  const client = createClient(model, apiKey, {
    includeUsage: !!debug,
    maxTokens: config.maxTokens,
    provider,
    baseUrl,
  });
  const tools = createDefaultRegistry(model, runner);

  // Load and connect MCP servers, registering their tools into the registry
  const mcpConfig = await loadMcpConfig(AGENT_DIR);
  const mcpManager = await McpManager.create(mcpConfig ?? { mcpServers: {} });
  if (mcpManager.connectedCount > 0) {
    await mcpManager.registerTools(tools);
    process.stderr.write(`[mcp] ${mcpManager.connectedCount} server(s) connected\n`);
  }

  const skills = new SkillRegistry();
  await skills.discover();

  const systemInstruction = await loadSystemInstruction();
  const agent = new Agent(client, tools, skills, systemInstruction, config.historySize, maxTurns, {
    model,
    onObservability: debug ? makeDebugHandler() : undefined,
  });
  return { agent, skills, mcpManager };
}
