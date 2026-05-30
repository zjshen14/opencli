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
  printToolResultExpanded,
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
  const spinner = createSpinner();
  spinner.start();
  const mdRenderer = new MarkdownStreamRenderer();
  const pendingEdits: { file_path: string; old_string: string; new_string: string }[] = [];
  let fullText = "";
  let turnText = "";

  try {
    for await (const event of agent.run(userMessage, mode)) {
      switch (event.type) {
        case "text":
          spinner.stop();
          turnText += event.text;
          fullText += event.text;
          mdRenderer.push(event.text);
          break;

        case "tool_call":
          spinner.stop();
          mdRenderer.flush();
          void session.log({
            type: "tool_call",
            name: event.name,
            args: event.args,
            ...(event.thoughtSignature ? { thoughtSignature: event.thoughtSignature } : {}),
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
          spinner.scheduleStart();
          break;

        case "tool_result":
          spinner.stop();
          void session.log({ type: "tool_result", name: event.name, result: event.result });
          if (COMPACT_TOOLS.has(event.name)) {
            printToolResultCompact(event.name, event.result);
          } else if (event.name === "edit") {
            const edit = pendingEdits.shift(); // always shift to keep array in sync
            if (event.result.startsWith("Error:")) {
              printToolResultExpanded("edit", event.result);
            } else if (edit) {
              printEditDiff(edit.old_string, edit.new_string, edit.file_path);
            }
          } else {
            printToolResult(event.name, event.result);
          }
          spinner.scheduleStart();
          break;

        case "skill_activated":
          spinner.stop();
          printSkillActivated(event.name);
          spinner.scheduleStart();
          break;

        case "error":
          spinner.stop();
          mdRenderer.flush();
          printError(event.message);
          break;

        case "done":
          spinner.stop();
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

// Varied verbs shown while waiting on the model or tool execution — picked
// at random each time the spinner restarts, so the UI feels alive across a
// long agentic loop instead of going silent after the first tool call.
const SPINNER_VERBS = [
  "Thinking",
  "Working",
  "Cooking",
  "Brewing",
  "Stewing",
  "Tinkering",
  "Pondering",
  "Crafting",
  "Reasoning",
  "Considering",
  "Exploring",
  "Noodling",
  "Hatching",
];

function createSpinner() {
  const frames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  // Delay before the spinner actually appears after scheduleStart(). Back-to-back
  // events (e.g. several parallel tool_results yielded synchronously) finish
  // within this window, so the spinner doesn't flash between them.
  const START_DELAY_MS = 80;
  let i = 0;
  let timer: NodeJS.Timeout | undefined;
  let pendingStart: NodeJS.Timeout | undefined;
  let visible = false;

  const pickVerb = () => SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)];

  const startNow = () => {
    if (visible) return;
    visible = true;
    const text = `${pickVerb()}…`;
    process.stderr.write(chalk.dim(`${frames[0]} ${text}`));
    i = 0;
    timer = setInterval(() => {
      process.stderr.write(`\r${chalk.cyan(frames[i % frames.length])} ${chalk.dim(text)}`);
      i++;
    }, 80);
  };

  return {
    start: startNow,
    scheduleStart() {
      if (pendingStart || visible) return;
      pendingStart = setTimeout(() => {
        pendingStart = undefined;
        startNow();
      }, START_DELAY_MS);
    },
    stop() {
      if (pendingStart) {
        clearTimeout(pendingStart);
        pendingStart = undefined;
      }
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      if (visible) {
        process.stderr.write("\r\x1b[K");
        visible = false;
      }
    },
  };
}
