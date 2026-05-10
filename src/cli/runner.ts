import chalk from "chalk";
import type { Agent, AgentRunMode } from "../core/agent.js";
import type { Session } from "../state/session.js";
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
} from "./renderer.js";

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
