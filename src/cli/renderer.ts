import chalk from "chalk";
import boxen from "boxen";
import * as Diff from "diff";
import { marked } from "marked";
// @ts-expect-error — marked-terminal has no types
import TerminalRenderer from "marked-terminal";

marked.setOptions({ renderer: new TerminalRenderer() });

export function renderMarkdown(text: string): string {
  return marked(text) as string;
}

export function printAssistantChunk(text: string): void {
  process.stdout.write(text);
}

export function printAssistantDone(): void {
  process.stdout.write("\n");
}

export function printToolCall(name: string, args: Record<string, unknown>): void {
  const header = chalk.bold.cyan(name);
  const body = formatToolArgs(name, args);
  const box = boxen(body, {
    title: header,
    titleAlignment: "left",
    padding: { top: 0, bottom: 0, left: 1, right: 1 },
    borderStyle: "round",
    borderColor: "cyan",
    dimBorder: true,
  });
  process.stderr.write(box + "\n");
}

export function printToolResult(name: string, result: string): void {
  const preview = result.slice(0, 160).replace(/\n/g, " ");
  const truncated = result.length > 160;
  process.stderr.write(chalk.dim(`  ← ${name}: ${preview}${truncated ? "…" : ""}`) + "\n");
}

export function printEditDiff(oldStr: string, newStr: string, filePath: string): void {
  const patch = Diff.createPatch(filePath, oldStr, newStr, "", "", {
    context: 3,
  });
  const lines = patch.split("\n").slice(4); // skip the file header lines
  const rendered = lines
    .map((line) => {
      if (line.startsWith("+")) return chalk.green(line);
      if (line.startsWith("-")) return chalk.red(line);
      if (line.startsWith("@@")) return chalk.cyan(line);
      return chalk.dim(line);
    })
    .join("\n");
  process.stderr.write(rendered + "\n");
}

export function printSkillActivated(name: string): void {
  process.stderr.write(chalk.magenta(`  ◆ skill activated: ${name}\n`));
}

export function printError(message: string): void {
  process.stderr.write(chalk.red(`Error: ${message}\n`));
}

export function printInfo(message: string): void {
  process.stderr.write(chalk.gray(message + "\n"));
}

// --- helpers ---

function formatToolArgs(name: string, args: Record<string, unknown>): string {
  // For edit: show file path only (diff is printed separately)
  if (name === "edit" && typeof args.file_path === "string") {
    return chalk.dim(args.file_path);
  }
  // For read/write/glob/grep: show the key path/pattern arg compactly
  const pathArg = args.file_path ?? args.path ?? args.pattern ?? args.command ?? null;
  if (typeof pathArg === "string") {
    const rest = Object.entries(args)
      .filter(([k]) => !["file_path", "path", "pattern", "command"].includes(k))
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");
    return chalk.dim(pathArg + (rest ? "  " + rest : ""));
  }
  // Fallback: compact JSON
  return chalk.dim(JSON.stringify(args).slice(0, 120));
}
