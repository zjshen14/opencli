import { Command } from "commander";
import { createClient } from "../model/factory.js";
import { Agent } from "../agent/core.js";
import { createDefaultRegistry } from "../tools/index.js";
import { SkillRegistry } from "../skills/registry.js";
import { loadConfig, saveConfig } from "../state/config.js";
import { Session } from "../state/session.js";
import { loadSystemInstruction } from "../agent/prompt.js";
import { runRepl } from "./repl.js";
import { printError, printInfo } from "./renderer.js";

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
  .action(async (opts) => {
    const sessionId = opts.session ?? (opts.resume ? "latest" : undefined);
    await startChat(opts.model, sessionId);
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
  .action(async (prompt: string, opts) => {
    await runSingle(prompt, opts.model);
  });

program
  .command("config")
  .description("View or set configuration")
  .option("--api-key <key>", "Set your Gemini API key")
  .option("--anthropic-api-key <key>", "Set your Anthropic API key")
  .option("--model <model>", "Set the default model")
  .action(async (opts) => {
    if (opts.apiKey) {
      await saveConfig({ apiKey: opts.apiKey });
      printInfo("Gemini API key saved.");
    }
    if (opts.anthropicApiKey) {
      await saveConfig({ anthropicApiKey: opts.anthropicApiKey });
      printInfo("Anthropic API key saved.");
    }
    if (opts.model) {
      await saveConfig({ model: opts.model });
      printInfo(`Default model set to ${opts.model}.`);
    }
    if (!opts.apiKey && !opts.anthropicApiKey && !opts.model) {
      const config = await loadConfig();
      console.log(
        JSON.stringify(
          {
            ...config,
            apiKey: config.apiKey ? "***" : undefined,
            anthropicApiKey: config.anthropicApiKey ? "***" : undefined,
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

async function startChat(modelOverride?: string, resumeSessionId?: string): Promise<void> {
  const { agent, skills } = await createAgent(modelOverride);
  await runRepl(agent, skills, resumeSessionId);
}

async function runSingle(prompt: string, modelOverride?: string): Promise<void> {
  const { agent } = await createAgent(modelOverride);
  for await (const event of agent.run(prompt)) {
    if (event.type === "text") process.stdout.write(event.text);
    if (event.type === "done") process.stdout.write("\n");
  }
}

async function createAgent(modelOverride?: string) {
  const config = await loadConfig();
  const model = process.env.OPENCLI_MODEL ?? modelOverride ?? config.model;

  const client = createClient(model, config);
  const tools = createDefaultRegistry();
  const skills = new SkillRegistry();
  await skills.discover();

  const systemInstruction = await loadSystemInstruction();
  const agent = new Agent(client, tools, skills, systemInstruction, config.historySize);
  return { agent, skills };
}
