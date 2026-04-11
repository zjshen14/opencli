import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import chalk from "chalk";
import type { Agent } from "../agent/core.js";
import type { SkillRegistry } from "../skills/registry.js";
import { loadSkillFile, processBody } from "../skills/loader.js";
import { join } from "node:path";
import {
  COMPACT_TOOLS,
  printAssistantChunk,
  printAssistantDone,
  printToolCall,
  printToolCallCompact,
  printToolResult,
  printToolResultCompact,
  printEditDiff,
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

      const body = await loadAndProcess(entry.dir, args);
      if (!body) continue;

      agent.injectSkill(entry.name, body);
      printSkillActivated(entry.name);

      input = args || `Please follow the ${entry.name} skill instructions.`;
    }

    // Run the agent loop
    const spinner = createSpinner("Thinking…");
    spinner.start();
    let firstToken = true;

    // Queue of pending edit args for diff rendering (matched in call order)
    const pendingEdits: { file_path: string; old_string: string; new_string: string }[] = [];

    try {
      for await (const event of agent.run(input)) {
        switch (event.type) {
          case "text":
            if (firstToken) {
              spinner.stop();
              firstToken = false;
            }
            printAssistantChunk(event.text);
            break;

          case "tool_call":
            if (firstToken) {
              spinner.stop();
              firstToken = false;
            }
            if (COMPACT_TOOLS.has(event.name)) {
              printToolCallCompact(event.name, event.args);
            } else {
              printToolCall(event.name, event.args);
              // Capture edit args for diff rendering
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
            if (COMPACT_TOOLS.has(event.name)) {
              printToolResultCompact(event.name, event.result);
            } else if (event.name === "edit") {
              const edit = pendingEdits.shift();
              if (edit) {
                printEditDiff(edit.old_string, edit.new_string, edit.file_path);
              }
            } else {
              printToolResult(event.name, event.result);
            }
            break;

          case "skill_activated":
            printSkillActivated(event.name);
            break;

          case "done":
            if (firstToken) {
              // No text at all (tool-only turn) — just stop spinner
              spinner.stop();
              firstToken = false;
            }
            printAssistantDone();
            break;
        }
      }
    } catch (err) {
      spinner.stop();
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

// Minimal spinner that only writes to stderr — never touches stdin,
// so it doesn't interfere with the readline interface on stdout.
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
      process.stderr.write("\r\x1b[K"); // overwrite spinner line with blank
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
