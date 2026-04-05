import { Command } from "commander";
import { GeminiClient } from "../model/gemini.js";
import { Agent } from "../agent/core.js";
import { createDefaultRegistry } from "../tools/index.js";
import { SkillRegistry } from "../skills/registry.js";
import { loadConfig, resolveApiKey, saveConfig } from "../state/config.js";
import { runRepl } from "./repl.js";
import { printError, printInfo } from "./renderer.js";

const program = new Command();

program
  .name("gemini-agent")
  .description("A general-purpose AI agent CLI powered by Google Gemini")
  .version("0.1.0");

// Default command: start interactive REPL
program
  .command("chat", { isDefault: true })
  .description("Start an interactive chat session")
  .option("-m, --model <model>", "Gemini model to use")
  .action(async (opts) => {
    await startChat(opts.model);
  });

// One-shot command: run a single prompt and exit
program
  .command("run <prompt>")
  .description("Run a single prompt and exit")
  .option("-m, --model <model>", "Gemini model to use")
  .action(async (prompt: string, opts) => {
    await runSingle(prompt, opts.model);
  });

// Config command
program
  .command("config")
  .description("View or set configuration")
  .option("--api-key <key>", "Set your Gemini API key")
  .option("--model <model>", "Set the default model")
  .action(async (opts) => {
    if (opts.apiKey) {
      await saveConfig({ apiKey: opts.apiKey });
      printInfo("API key saved.");
    }
    if (opts.model) {
      await saveConfig({ model: opts.model });
      printInfo(`Default model set to ${opts.model}.`);
    }
    if (!opts.apiKey && !opts.model) {
      const config = await loadConfig();
      console.log(
        JSON.stringify({ ...config, apiKey: config.apiKey ? "***" : undefined }, null, 2),
      );
    }
  });

program.parseAsync(process.argv).catch((err) => {
  printError(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

async function startChat(modelOverride?: string): Promise<void> {
  const { agent, skills } = await createAgent(modelOverride);
  await runRepl(agent, skills);
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
  const apiKey = resolveApiKey(config);
  const model = process.env.GEMINI_MODEL ?? modelOverride ?? config.model;

  const gemini = new GeminiClient(apiKey, model);
  const tools = createDefaultRegistry();
  const skills = new SkillRegistry();
  await skills.discover();

  const agent = new Agent(gemini, tools, skills);
  return { agent, skills };
}
