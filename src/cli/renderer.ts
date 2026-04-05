import chalk from "chalk";
import { marked } from "marked";
// @ts-expect-error — marked-terminal has no types
import TerminalRenderer from "marked-terminal";

marked.setOptions({ renderer: new TerminalRenderer() });

export function renderMarkdown(text: string): string {
  return marked(text) as string;
}

export function printUser(text: string): void {
  process.stdout.write(chalk.cyan("You: ") + text + "\n");
}

export function printAssistantChunk(text: string): void {
  process.stdout.write(text);
}

export function printAssistantDone(): void {
  process.stdout.write("\n");
}

export function printToolCall(name: string, args: Record<string, unknown>): void {
  const preview = JSON.stringify(args).slice(0, 80);
  process.stderr.write(chalk.dim(`  → ${name}(${preview}${preview.length >= 80 ? "…" : ""})\n`));
}

export function printToolResult(name: string, result: string): void {
  const preview = result.slice(0, 120).replace(/\n/g, " ");
  process.stderr.write(chalk.dim(`  ← ${name}: ${preview}${result.length > 120 ? "…" : ""}\n`));
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
