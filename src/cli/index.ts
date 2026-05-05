import { Command } from "commander";
import { createClient, detectProvider } from "../providers/factory.js";
import { Agent } from "../core/agent.js";
import { createDefaultRegistry } from "../tools/index.js";
import { SkillRegistry } from "../skills/registry.js";
import { loadConfig, saveConfig } from "../state/config.js";
import { Session } from "../state/session.js";
import { loadSystemInstruction } from "../core/prompt.js";
import { resolveApiKey } from "./keys.js";
import { runRepl, createConfirmFn } from "./repl.js";
import { printError, printInfo } from "./renderer.js";
import type { ObservabilityEvent } from "../core/observability.js";

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
  .action(async (opts) => {
    const sessionId = opts.session ?? (opts.resume ? "latest" : undefined);
    await startChat(opts.model, sessionId, opts.maxTurns, opts.debug as boolean | undefined);
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
  .action(async (prompt: string, opts) => {
    await runSingle(
      prompt,
      opts.model,
      opts.maxTurns,
      opts.plan as boolean | undefined,
      opts.yes as boolean | undefined,
      opts.debug as boolean | undefined,
    );
  });

program
  .command("config")
  .description("View or set configuration")
  .option("--gemini-api-key <key>", "Set your Gemini API key")
  .option("--anthropic-api-key <key>", "Set your Anthropic API key")
  .option("--openai-api-key <key>", "Set your OpenAI API key")
  .option("--model <model>", "Set the default model")
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
    if (!opts.geminiApiKey && !opts.anthropicApiKey && !opts.openaiApiKey && !opts.model) {
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

program.parseAsync(process.argv).catch((err) => {
  printError(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

async function startChat(
  modelOverride?: string,
  resumeSessionId?: string,
  maxTurns?: number,
  debug?: boolean,
): Promise<void> {
  const { agent, skills } = await createAgent(modelOverride, maxTurns, debug);
  await runRepl(agent, skills, resumeSessionId);
}

async function runSingle(
  prompt: string,
  modelOverride?: string,
  maxTurns?: number,
  planMode?: boolean,
  autoApprove?: boolean,
  debug?: boolean,
): Promise<void> {
  const { agent } = await createAgent(modelOverride, maxTurns, debug);
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
}

function makeDebugHandler(): (event: ObservabilityEvent) => void {
  return (event) => process.stderr.write(JSON.stringify(event) + "\n");
}

async function createAgent(modelOverride?: string, maxTurns?: number, debug?: boolean) {
  const config = await loadConfig();
  const model = process.env.OPENCLI_MODEL ?? modelOverride ?? config.model;

  const provider = detectProvider(model);
  const apiKey = resolveApiKey(provider, config);
  const client = createClient(model, apiKey, {
    includeUsage: !!debug,
    maxTokens: config.maxTokens,
  });
  const tools = createDefaultRegistry(model);
  const skills = new SkillRegistry();
  await skills.discover();

  const systemInstruction = await loadSystemInstruction();
  const agent = new Agent(client, tools, skills, systemInstruction, config.historySize, maxTurns, {
    model,
    onObservability: debug ? makeDebugHandler() : undefined,
  });
  return { agent, skills };
}
