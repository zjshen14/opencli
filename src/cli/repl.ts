import chalk from "chalk";
import type { Agent } from "../core/agent.js";
import type { SkillRegistry } from "../skills/registry.js";
import { loadSkillFile, processBody } from "../skills/loader.js";
import { join } from "node:path";
import { readLine, loadHistory, saveHistory, type SlashCommand } from "./input.js";
import { expandMentions } from "./mentions.js";
import { probeServer } from "./mcp-cmd.js";
import { loadMcpConfig } from "../mcp/config.js";
import { AGENT_DIR } from "../state/config.js";
import { Session } from "../state/session.js";
import { printSkillActivated, printError, printInfo } from "./renderer.js";
import { createConfirmFn } from "./confirm.js";
import { runAgentTurn } from "./runner.js";
import { runPlanFlow } from "./plan.js";
import type { SnapshotManager } from "../state/snapshot.js";

// Built-in slash commands (always available)
const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: "help", description: "list available skills and commands" },
  { name: "plan", description: "explore and draft a plan, then approve before executing" },
  { name: "compact", description: "summarize older conversation history to free context" },
  { name: "context", description: "show current token usage vs. context window" },
  { name: "rewind", description: "undo agent file changes since last snapshot" },
  { name: "undo", description: "remove the last user message and agent response from history" },
  { name: "clear", description: "clear conversation history" },
  { name: "exit", description: "exit the agent" },
];

export async function runRepl(
  agent: Agent,
  skills: SkillRegistry,
  resumeSessionId?: string,
  onExit?: () => Promise<void>,
  snapshotManager?: SnapshotManager,
): Promise<void> {
  const { confirmFn, forcesConfirmation } = await createConfirmFn();
  agent.setConfirmFn(confirmFn);
  agent.setForcesConfirmationFn(forcesConfirmation);
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

  const cwd = process.cwd();
  const history = await loadHistory(cwd);
  const skillCommands: SlashCommand[] = skills
    .list()
    .map((s) => ({ name: s.name, description: s.description }));
  const allCommands = [...BUILTIN_COMMANDS, ...skillCommands];

  while (true) {
    const raw = await readLine(history, allCommands, { onExit });

    // EOF (Ctrl+D)
    if (raw === null) break;

    const rawInput = raw.trim();
    if (!rawInput) continue;

    // Persist original input to history (skip duplicates at the top)
    if (history[0] !== rawInput) {
      history.unshift(rawInput);
    }

    // Expand @file/@glob mentions before passing to agent or slash commands
    const { expanded, warnings } = await expandMentions(rawInput, cwd);
    for (const w of warnings) printInfo(w);
    const input = expanded;

    // NOTE: user messages are logged at the point they actually reach the agent
    // (just before runPlanFlow / runAgentTurn below). Logging here would persist
    // REPL-only commands like /exit, /help, /clear as user content — resumed
    // sessions would then replay them as consecutive user messages and the
    // provider would reject with INVALID_ARGUMENT (role alternation violated).

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
    if (input === "/undo") {
      const removed = agent.undoLastTurn();
      if (removed === 0) {
        printInfo("Nothing to undo — conversation is empty.");
      } else {
        printInfo(`Undid last turn (${removed} message${removed === 1 ? "" : "s"} removed).`);
      }
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
      void session.log({ type: "user", content: planPrompt });
      await runPlanFlow(agent, session, planPrompt);
      continue;
    }

    // /compact — summarize older conversation history to free context
    if (input === "/compact") {
      const stats = agent.getContextStats();
      if (stats.messageCount < 4) {
        printInfo("Nothing to compact — conversation is too short.");
        continue;
      }
      printInfo("Compacting conversation history…");
      try {
        const result = await agent.compact();
        if (result.messagesRemoved === 0) {
          printInfo("Nothing to compact — recent messages fill the full window.");
        } else {
          printInfo(
            `Compacted ${result.messagesRemoved} message(s) into a ${result.summaryLength}-char summary.`,
          );
        }
      } catch (err) {
        printError(`Compaction failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }

    // /context — show estimated token usage vs. context window
    if (input === "/context") {
      const { messageCount, estimatedTokens, contextWindow } = agent.getContextStats();
      const pct = Math.round((estimatedTokens / contextWindow) * 100);
      printInfo(
        `Est. tokens:  ~${estimatedTokens.toLocaleString()} / ${contextWindow.toLocaleString()}  (${pct}%)`,
      );
      printInfo(`Messages:     ${messageCount}`);
      continue;
    }

    // /rewind — restore working tree to pre-write snapshot
    if (input === "/rewind") {
      if (snapshotManager && !snapshotManager.snapshotEnabled) {
        printInfo("Snapshot disabled (OPENCLI_SNAPSHOT=off).");
      } else if (snapshotManager && !snapshotManager.gitAvailable) {
        printInfo("Rewind unavailable: not in a git repo, or git not installed.");
      } else if (!snapshotManager || !snapshotManager.hasSnapshot) {
        printInfo("No snapshot — no writes have happened this session.");
      } else {
        const result = await snapshotManager.rewind();
        if (result.ok) {
          if (result.restoredFiles.length === 0) {
            printInfo("Working tree already matches snapshot — nothing to restore.");
          } else {
            printInfo(`Rewound ${result.restoredFiles.length} file(s):`);
            for (const f of result.restoredFiles) {
              process.stderr.write(`  ${f}\n`);
            }
          }
        } else {
          printError(`Rewind failed: ${result.error}`);
          if (snapshotManager.lastSnapshotSha) {
            printError(
              `To recover manually: git restore --source ${snapshotManager.lastSnapshotSha} --worktree .`,
            );
          }
        }
      }
      continue;
    }

    // /mcp — quick MCP management from within the REPL
    if (input === "/mcp" || input.startsWith("/mcp ")) {
      const subArg = input.slice(4).trim();
      if (!subArg || subArg === "list") {
        const config = await loadMcpConfig(AGENT_DIR);
        if (!config || Object.keys(config.mcpServers).length === 0) {
          printInfo("No MCP servers configured. Run `opencli mcp add` to add one.\n");
        } else {
          for (const [name, cfg] of Object.entries(config.mcpServers)) {
            process.stderr.write(chalk.bold(name) + chalk.dim(` [${cfg.transport}]`) + "\n");
          }
        }
      } else if (subArg.startsWith("test ")) {
        const serverName = subArg.slice(5).trim();
        const config = await loadMcpConfig(AGENT_DIR);
        const serverConfig = config?.mcpServers[serverName];
        if (!serverConfig) {
          printError(`No server named '${serverName}' in mcp.json.`);
        } else {
          process.stderr.write(`[mcp] connecting to ${serverName}...\n`);
          const probe = await probeServer(serverName, serverConfig);
          if (probe.ok) {
            process.stderr.write(
              chalk.green(`[mcp] ✓ ok — ${probe.tools!.length} tools in ${probe.latencyMs}ms\n`),
            );
            for (const t of probe.tools!) {
              process.stderr.write(`       • ${t}\n`);
            }
          } else {
            printError(`[mcp] ✗ ${probe.error}`);
          }
        }
      } else {
        printError(`Unknown /mcp subcommand. Use /mcp or /mcp test <name>.`);
      }
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

    void session.log({ type: "user", content: userMessage });
    await runAgentTurn(agent, session, userMessage);
  }

  await saveHistory(history, cwd);
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
