import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import chalk from "chalk";
import type { Agent } from "../agent/core.js";
import type { SkillRegistry } from "../skills/registry.js";
import { loadSkillFile, processBody } from "../skills/loader.js";
import { join } from "node:path";
import {
  printAssistantChunk,
  printAssistantDone,
  printToolCall,
  printToolResult,
  printSkillActivated,
  printError,
  printInfo,
} from "./renderer.js";

export async function runRepl(agent: Agent, skills: SkillRegistry): Promise<void> {
  const rl = readline.createInterface({ input: stdin, output: stdout });

  printInfo(`Gemini Agent — type /help for available skills, Ctrl+C to exit\n`);

  rl.on("SIGINT", () => {
    console.log("\nGoodbye.");
    process.exit(0);
  });

  while (true) {
    let input: string;
    try {
      input = await rl.question(chalk.green("› "));
    } catch {
      break;
    }

    input = input.trim();
    if (!input) continue;

    // Built-in meta-commands
    if (input === "/help") {
      printSkillList(skills);
      continue;
    }
    if (input === "/clear") {
      agent.clearHistory();
      printInfo("History cleared.");
      continue;
    }
    if (input === "/exit" || input === "/quit") {
      break;
    }

    // Skill invocation: /skill-name [args]
    if (input.startsWith("/")) {
      const [slashName, ...argParts] = input.slice(1).split(/\s+/);
      const args = argParts.join(" ");
      const entry = skills.get(slashName);

      if (!entry) {
        printError(`Unknown skill: ${slashName}. Type /help to list available skills.`);
        continue;
      }

      // Load, preprocess, inject, then forward to agent
      const body = await loadAndProcess(entry.dir, args);
      if (!body) continue;

      agent.injectSkill(entry.name, body);
      printSkillActivated(entry.name);

      // If args were provided, use them as the user message; otherwise use the skill name as prompt
      input = args || `Please follow the ${entry.name} skill instructions.`;
    }

    // Run the agent loop
    try {
      for await (const event of agent.run(input)) {
        switch (event.type) {
          case "text":
            printAssistantChunk(event.text);
            break;
          case "tool_call":
            printToolCall(event.name, event.args);
            break;
          case "tool_result":
            printToolResult(event.name, event.result);
            break;
          case "skill_activated":
            printSkillActivated(event.name);
            break;
          case "done":
            printAssistantDone();
            break;
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      printError(message);
    }
  }

  rl.close();
}

function printSkillList(skills: SkillRegistry): void {
  const entries = skills.list();
  if (entries.length === 0) {
    printInfo("No skills available.");
    return;
  }
  printInfo("\nAvailable skills:");
  for (const s of entries) {
    process.stderr.write(chalk.magenta(`  /${s.name}`) + chalk.gray(` — ${s.description}\n`));
  }
  printInfo("\nBuilt-in commands: /clear, /exit\n");
}

async function loadAndProcess(skillDir: string, args: string): Promise<string | undefined> {
  try {
    const meta = await loadSkillFile(join(skillDir, "SKILL.md"));
    return processBody(meta.body, args);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    printError(`Failed to load skill: ${message}`);
    return undefined;
  }
}
