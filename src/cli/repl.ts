import chalk from "chalk";
import type { Agent } from "../agent/core.js";
import type { SkillRegistry } from "../skills/registry.js";
import { loadSkillFile, processBody } from "../skills/loader.js";
import { join } from "node:path";
import { readLine, loadHistory, saveHistory, type SlashCommand } from "./input.js";
import { Session } from "../state/session.js";
import {
  COMPACT_TOOLS,
  MarkdownStreamRenderer,
  printToolCall,
  printToolCallCompact,
  printToolResult,
  printToolResultCompact,
  printEditDiff,
  printSkillActivated,
  printError,
  printInfo,
} from "./renderer.js";

// Built-in slash commands (always available)
const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: "help", description: "list available skills and commands" },
  { name: "clear", description: "clear conversation history" },
  { name: "exit", description: "exit the agent" },
];

export async function runRepl(
  agent: Agent,
  skills: SkillRegistry,
  resumeSessionId?: string,
): Promise<void> {
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

  // Load persisted history and build the command list for the popup
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

    // Run the agent loop
    const spinner = createSpinner("Thinking…");
    spinner.start();
    let firstToken = true;
    const mdRenderer = new MarkdownStreamRenderer();
    const pendingEdits: { file_path: string; old_string: string; new_string: string }[] = [];

    try {
      let assistantText = "";
      for await (const event of agent.run(userMessage)) {
        switch (event.type) {
          case "text":
            if (firstToken) {
              spinner.stop();
              firstToken = false;
            }
            assistantText += event.text;
            mdRenderer.push(event.text);
            break;

          case "tool_call":
            if (firstToken) {
              spinner.stop();
              firstToken = false;
            }
            mdRenderer.flush();
            void session.log({ type: "tool_call", name: event.name, args: event.args });
            if (COMPACT_TOOLS.has(event.name)) {
              printToolCallCompact(event.name, event.args);
            } else {
              printToolCall(event.name, event.args);
              if (
                event.name === "edit" &&
                typeof event.args.file_path === "string" &&
                typeof event.args.old_string === "string" &&
                typeof event.args.new_string === "string"
              ) {
                pendingEdits.push({
                  file_path: event.args.file_path as string,
                  old_string: event.args.old_string as string,
                  new_string: event.args.new_string as string,
                });
              }
            }
            break;

          case "tool_result":
            void session.log({ type: "tool_result", name: event.name, result: event.result });
            if (COMPACT_TOOLS.has(event.name)) {
              printToolResultCompact(event.name, event.result);
            } else if (event.name === "edit") {
              const edit = pendingEdits.shift();
              if (edit) printEditDiff(edit.old_string, edit.new_string, edit.file_path);
            } else {
              printToolResult(event.name, event.result);
            }
            break;

          case "skill_activated":
            printSkillActivated(event.name);
            break;

          case "done":
            if (firstToken) {
              spinner.stop();
              firstToken = false;
            }
            mdRenderer.flush();
            void session.log({ type: "assistant", content: assistantText });
            assistantText = "";
            break;
        }
      }
    } catch (err) {
      spinner.stop();
      const message = err instanceof Error ? err.message : String(err);
      printError(message);
    }
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

function createSpinner(text: string) {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let i = 0;
  let timer: NodeJS.Timeout | undefined;
  return {
    start() {
      process.stderr.write(chalk.dim(`${frames[0]} ${text}`));
      timer = setInterval(() => {
        process.stderr.write(`\r${chalk.cyan(frames[i % frames.length])} ${chalk.dim(text)}`);
        i++;
      }, 80);
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      process.stderr.write("\r\x1b[K");
    },
  };
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
