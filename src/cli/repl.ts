import chalk from "chalk";
import { execFileSync } from "node:child_process";
import { writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { Agent, AgentRunMode } from "../core/agent.js";
import type { SkillRegistry } from "../skills/registry.js";
import { loadSkillFile, processBody } from "../skills/loader.js";
import { join } from "node:path";
import { readLine, selectKey, loadHistory, saveHistory, type SlashCommand } from "./input.js";
import { probeServer } from "./mcp-cmd.js";
import { loadMcpConfig } from "../mcp/config.js";
import { AGENT_DIR } from "../state/config.js";
import type { ConfirmFn } from "../core/executor.js";
import { loadConfig, saveConfig } from "../state/config.js";
import { loadSettings, saveSettings } from "../state/settings.js";
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
  { name: "plan", description: "explore and draft a plan, then approve before executing" },
  { name: "clear", description: "clear conversation history" },
  { name: "exit", description: "exit the agent" },
];

export async function createConfirmFn(): Promise<ConfirmFn> {
  const [config, settings] = await Promise.all([loadConfig(), loadSettings()]);

  const globalAllowSet = new Set<string>(config.permissions?.allow ?? []);
  const projectAllowSet = new Set<string>(settings.permissions?.allow ?? []);

  return async (toolName, args) => {
    if (!process.stdin.isTTY) return "deny";

    const exactKey = `${toolName}:${JSON.stringify(args)}`;
    const toolWildcard = `${toolName}:*`;

    // Derive MCP server wildcard from name like mcp__<server>__<tool>
    const mcpMatch = toolName.match(/^mcp__([^_][^_]*)__/);
    const serverWildcard = mcpMatch ? `mcp__${mcpMatch[1]}__*` : null;

    const isAllowed = (key: string) => globalAllowSet.has(key) || projectAllowSet.has(key);

    if (
      isAllowed(exactKey) ||
      isAllowed(toolWildcard) ||
      (serverWildcard && isAllowed(serverWildcard))
    ) {
      return "allow";
    }

    const detail =
      toolName === "bash"
        ? (args.command as string)
        : toolName === "write" || toolName === "edit"
          ? (args.file_path as string)
          : JSON.stringify(args);

    process.stderr.write(chalk.yellow(`\n  ⚠  ${toolName} requires confirmation\n`));
    process.stderr.write(chalk.dim(`     ${detail}\n`));

    const isMcp = toolName.startsWith("mcp__");
    const options: Array<{ key: string; label: string }> = [
      { key: "y", label: "Yes, run once" },
      { key: "p", label: "Yes, always for this project  (.opencli/settings.json)" },
      { key: "g", label: "Yes, always globally          (~/.opencli/config.json)" },
    ];
    if (isMcp) {
      options.push({ key: "t", label: `Yes, always for this tool, any args  (project)` });
      options.push({
        key: "s",
        label: `Yes, always for any tool from '${mcpMatch![1]}'  (project)`,
      });
    }
    options.push({ key: "n", label: "No, skip" });

    const choice = await selectKey(`Allow ${toolName}?`, options);

    if (choice === null || choice === "n") return "deny";

    if (choice === "p") {
      projectAllowSet.add(exactKey);
      await saveSettings({ permissions: { allow: [...projectAllowSet] } });
    } else if (choice === "g") {
      globalAllowSet.add(exactKey);
      const cfg = await loadConfig();
      await saveConfig({ permissions: { ...cfg.permissions, allow: [...globalAllowSet] } });
    } else if (choice === "t") {
      projectAllowSet.add(toolWildcard);
      await saveSettings({ permissions: { allow: [...projectAllowSet] } });
    } else if (choice === "s" && serverWildcard) {
      projectAllowSet.add(serverWildcard);
      await saveSettings({ permissions: { allow: [...projectAllowSet] } });
    }

    return "allow";
  };
}

export async function runRepl(
  agent: Agent,
  skills: SkillRegistry,
  resumeSessionId?: string,
  onExit?: () => Promise<void>,
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

  // Load persisted history and build the command list for the popup
  const history = await loadHistory();
  const skillCommands: SlashCommand[] = skills
    .list()
    .map((s) => ({ name: s.name, description: s.description }));
  const allCommands = [...BUILTIN_COMMANDS, ...skillCommands];

  while (true) {
    const raw = await readLine(history, allCommands, { onExit });

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
      const planText = await runAgentTurn(agent, session, planPrompt, "plan");
      if (!planText.trim()) continue;

      const decision = await promptPlanApproval();
      if (decision === "cancel") {
        printInfo("Plan cancelled.");
        continue;
      }
      let finalPlan = planText;
      if (decision === "edit") {
        const edited = await editPlanInEditor(planText);
        if (!edited) {
          printInfo("Edit cancelled.");
          continue;
        }
        finalPlan = edited;
      }
      printInfo("\nExecuting approved plan…\n");
      await runAgentTurn(
        agent,
        session,
        `I have approved the following plan. Execute it step by step, checking off each item as you complete it:\n\n${finalPlan}`,
        "react",
      );
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

    await runAgentTurn(agent, session, userMessage);
  }

  await saveHistory(history);
  process.stdout.write(chalk.gray("Goodbye.\n"));
}

// ── helpers ───────────────────────────────────────────────────────────────────

export async function runAgentTurn(
  agent: Agent,
  session: Session,
  userMessage: string,
  mode: AgentRunMode = "react",
): Promise<string> {
  const spinner = createSpinner("Thinking…");
  spinner.start();
  let firstToken = true;
  const mdRenderer = new MarkdownStreamRenderer();
  const pendingEdits: { file_path: string; old_string: string; new_string: string }[] = [];
  let fullText = "";
  let turnText = "";

  try {
    for await (const event of agent.run(userMessage, mode)) {
      switch (event.type) {
        case "text":
          if (firstToken) {
            spinner.stop();
            firstToken = false;
          }
          turnText += event.text;
          fullText += event.text;
          mdRenderer.push(event.text);
          break;

        case "tool_call":
          if (firstToken) {
            spinner.stop();
            firstToken = false;
          }
          mdRenderer.flush();
          void session.log({
            type: "tool_call",
            name: event.name,
            args: event.args,
          });
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

        case "error":
          spinner.stop();
          mdRenderer.flush();
          printError(event.message);
          break;

        case "done":
          if (firstToken) {
            spinner.stop();
            firstToken = false;
          }
          mdRenderer.flush();
          void session.log({ type: "assistant", content: turnText });
          turnText = "";
          break;
      }
    }
  } catch (err) {
    spinner.stop();
    const message = err instanceof Error ? err.message : String(err);
    printError(message);
  }

  return fullText;
}

async function promptPlanApproval(): Promise<"approve" | "edit" | "cancel"> {
  const choice = await selectKey("Plan ready — what next?", [
    { key: "a", label: "Approve & execute" },
    { key: "e", label: "Edit in $EDITOR first" },
    { key: "c", label: "Cancel" },
  ]);
  if (choice === "a") return "approve";
  if (choice === "e") return "edit";
  return "cancel";
}

async function editPlanInEditor(plan: string): Promise<string | null> {
  const tmpPath = join(tmpdir(), `opencli-plan-${Date.now()}.md`);
  await writeFile(tmpPath, plan);
  const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
  try {
    execFileSync(editor, [tmpPath], { stdio: "inherit" });
    const edited = await readFile(tmpPath, "utf8");
    return edited.trim() || null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    printError(`Failed to open editor (${editor}): ${message}`);
    return null;
  } finally {
    await rm(tmpPath).catch(() => {});
  }
}

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
