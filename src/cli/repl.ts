import chalk from "chalk";
import type { Agent } from "../core/agent.js";
import type { SkillRegistry } from "../skills/registry.js";
import { loadSkillFile, processBody } from "../skills/loader.js";
import { join } from "node:path";
import { readLine, loadHistory, saveHistory, type SlashCommand } from "./input.js";
import { Session } from "../state/session.js";
import { printSkillActivated, printError, printInfo } from "./renderer.js";
import { createConfirmFn } from "./confirm.js";
import { runAgentTurn } from "./runner.js";
import { runPlanFlow } from "./plan.js";

// Built-in slash commands (always available)
const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: "help", description: "list available skills and commands" },
  { name: "plan", description: "explore and draft a plan, then approve before executing" },
  { name: "clear", description: "clear conversation history" },
  { name: "exit", description: "exit the agent" },
];

export async function runRepl(
  agent: Agent,
  skills: SkillRegistry,
  resumeSessionId?: string,
): Promise<void> {
  agent.setConfirmFn(await createConfirmFn());
  printInfo(`OpenCLI — type /help for commands, Ctrl+C to exit\n`);

  let session: Session;
  if (resumeSessionId) {
    const { session: s, messages } = await Session.loadMessages(resumeSessionId);
    session = s;
    agent.restoreMessages(messages);
    printInfo(`Resumed session ${s.id} (${messages.length} messages restored)\n`);
  } else {
    session = await Session.create();
  }
  agent.setSessionTmpDir(session.tmpDir);

  const history = await loadHistory();
  const skillCommands: SlashCommand[] = skills
    .list()
    .map((s) => ({ name: s.name, description: s.description }));
  const allCommands = [...BUILTIN_COMMANDS, ...skillCommands];

  while (true) {
    const raw = await readLine(history, allCommands);

    // EOF (Ctrl+D)
    if (raw === null) break;

    const input = raw.trim();
    if (!input) continue;

    // Persist to history (skip duplicates at the top)
    if (history[0] !== input) {
      history.unshift(input);
    }
    void session.log({ type: "user", content: input });

    // Built-in commands
    if (input === "/help") {
      printCommandList(allCommands, skills);
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

    // /plan <task> — read-only planning pass with user approval before execution
    if (input === "/plan" || input.startsWith("/plan ")) {
      const planPrompt = input.slice(5).trim();
      if (!planPrompt) {
        printError("Usage: /plan <task description>");
        continue;
      }
      await runPlanFlow(agent, session, planPrompt);
      continue;
    }

    // Skill invocation: /skill-name [args]
    let userMessage = input;
    if (input.startsWith("/")) {
      const [slashName, ...argParts] = input.slice(1).split(/\s+/);
      const args = argParts.join(" ");
      const entry = skills.get(slashName);

      if (!entry) {
        printError(`Unknown command: /${slashName}. Type /help to list available commands.`);
        continue;
      }

      const body = await loadAndProcess(entry.dir, args);
      if (!body) continue;

      agent.injectSkill(entry.name, body);
      printSkillActivated(entry.name);
      userMessage = args || `Please follow the ${entry.name} skill instructions.`;
    }

    await runAgentTurn(agent, session, userMessage);
  }

  await saveHistory(history);
  process.stdout.write(chalk.gray("Goodbye.\n"));
}

// ── helpers ───────────────────────────────────────────────────────────────────

function printCommandList(commands: SlashCommand[], skills: SkillRegistry): void {
  const builtins = commands.filter((c) => BUILTIN_COMMANDS.some((b) => b.name === c.name));
  const skillEntries = skills.list();

  printInfo("\nBuilt-in commands:");
  for (const c of builtins) {
    process.stderr.write(chalk.green(`  /${c.name}`) + chalk.gray(` — ${c.description}\n`));
  }

  if (skillEntries.length > 0) {
    printInfo("\nSkills:");
    for (const s of skillEntries) {
      process.stderr.write(chalk.magenta(`  /${s.name}`) + chalk.gray(` — ${s.description}\n`));
    }
  }

  process.stderr.write("\n");
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
