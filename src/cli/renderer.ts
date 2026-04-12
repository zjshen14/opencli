import chalk from "chalk";
import boxen from "boxen";
import * as Diff from "diff";
import { marked } from "marked";
// @ts-expect-error — marked-terminal has no types
import TerminalRenderer from "marked-terminal";

marked.setOptions({ renderer: new TerminalRenderer() });

// Tools that render as compact one-liners (read-only, low noise)
export const COMPACT_TOOLS = new Set(["read", "glob", "grep"]);

export function renderMarkdown(text: string): string {
  return marked(text) as string;
}

/**
 * Scan buf for the first "\n\n" that occurs outside a code fence (```).
 * Returns the index immediately after the "\n\n", or -1 if none found.
 */
function findOutsideFence(buf: string): number {
  let inFence = false;
  let i = 0;
  while (i < buf.length) {
    if (buf.startsWith("```", i)) {
      inFence = !inFence;
      i += 3;
      continue;
    }
    if (!inFence && buf[i] === "\n" && buf[i + 1] === "\n") {
      return i + 2;
    }
    i++;
  }
  return -1;
}

/**
 * Paragraph-level streaming markdown renderer.
 *
 * Strategy: buffer incoming text chunks and flush completed paragraphs
 * (separated by "\n\n") through marked-terminal. Code fences (```) are
 * treated as atomic — we never flush mid-fence, even if a blank line
 * appears inside.
 *
 * Usage:
 *   const r = new MarkdownStreamRenderer();
 *   for each chunk: r.push(chunk);
 *   r.flush(); // on done — render any remaining buffered text
 */
export class MarkdownStreamRenderer {
  private buf = "";

  push(chunk: string): void {
    this.buf += chunk;

    // Find the next \n\n that falls outside a code fence by scanning linearly.
    // Returns the index just after the \n\n, or -1 if none found outside a fence.
    let boundary: number;
    while ((boundary = findOutsideFence(this.buf)) !== -1) {
      const para = this.buf.slice(0, boundary);
      this.buf = this.buf.slice(boundary);
      process.stdout.write(renderMarkdown(para));
    }
  }

  flush(): void {
    if (this.buf.trim()) {
      process.stdout.write(renderMarkdown(this.buf));
    }
    this.buf = "";
    process.stdout.write("\n");
  }
}

// Full bordered box for write/exec tools — printed when the call is issued
export function printToolCall(name: string, args: Record<string, unknown>): void {
  const { color, icon } = toolStyle(name);
  const header = chalk.bold[color](name);
  const body = formatToolArgs(name, args);
  // Cap width at terminal width so long commands don't break the box borders.
  // 6 = 2 (border chars) + 2 (horizontal padding each side) + 2 (safety margin)
  const maxWidth = (process.stdout.columns ?? 100) - 6;
  const box = boxen(`${icon} ${body}`, {
    title: header,
    titleAlignment: "left",
    padding: { top: 0, bottom: 0, left: 1, right: 1 },
    borderStyle: "round",
    borderColor: color,
    dimBorder: true,
    width: maxWidth,
  });
  process.stderr.write(box + "\n");
}

// Result line appended below the full box once execution completes
export function printToolResult(name: string, result: string): void {
  if (name === "edit") return; // edit results are shown as a diff instead
  const summary = summariseResult(name, result);
  process.stderr.write(chalk.dim(`  ✓ ${summary}`) + "\n");
}

// Compact one-liner for read/glob/grep — printed when the call is issued
export function printToolCallCompact(name: string, args: Record<string, unknown>): void {
  const arg = compactArg(args);
  process.stderr.write(chalk.dim(`  ○ ${name.padEnd(6)}${arg}`) + "\n");
}

// Overwrites the compact call line with a ✓ result summary
export function printToolResultCompact(name: string, result: string): void {
  const summary = summariseResult(name, result);
  process.stderr.write(chalk.dim(`  ✓ ${summary}`) + "\n");
}

export function printEditDiff(oldStr: string, newStr: string, filePath: string): void {
  const patch = Diff.createPatch(filePath, oldStr, newStr, "", "", { context: 3 });
  const lines = patch.split("\n").slice(4); // skip file header
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

// --- helpers (exported for testing) ---

export type ChalkColor = "magenta" | "yellow" | "cyan" | "white";

export function toolStyle(name: string): { color: ChalkColor; icon: string } {
  if (name === "bash") return { color: "magenta", icon: "❯" };
  if (name === "write" || name === "edit") return { color: "yellow", icon: "✎" };
  return { color: "cyan", icon: "⟳" };
}

export function formatToolArgs(name: string, args: Record<string, unknown>): string {
  if (name === "edit" && typeof args.file_path === "string") {
    return chalk.dim(args.file_path);
  }
  // pattern before path so grep/glob show the search term rather than the directory
  const pathArg = args.file_path ?? args.pattern ?? args.path ?? args.command ?? null;
  if (typeof pathArg === "string") {
    const rest = Object.entries(args)
      .filter(([k]) => !["file_path", "path", "pattern", "command"].includes(k))
      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
      .join(" ");
    return chalk.dim(pathArg + (rest ? "  " + rest : ""));
  }
  return chalk.dim(JSON.stringify(args).slice(0, 120));
}

export function compactArg(args: Record<string, unknown>): string {
  const val = args.file_path ?? args.path ?? args.pattern ?? null;
  return typeof val === "string" ? chalk.dim(val) : chalk.dim(JSON.stringify(args).slice(0, 80));
}

export function summariseResult(name: string, result: string): string {
  const trimmed = result.trim();

  if (name === "read") {
    const lines = trimmed.split("\n").length;
    const filePath = trimmed.split("\n")[0]?.slice(0, 60) ?? "";
    return `${name.padEnd(6)}${chalk.dim(`${filePath}  (${lines} lines)`)}`;
  }
  if (name === "glob") {
    const files = trimmed ? trimmed.split("\n").length : 0;
    return `${name.padEnd(6)}${chalk.dim(`${files} file${files === 1 ? "" : "s"}`)}`;
  }
  if (name === "grep") {
    const matches = trimmed ? trimmed.split("\n").length : 0;
    return `${name.padEnd(6)}${chalk.dim(`${matches} match${matches === 1 ? "" : "es"}`)}`;
  }
  if (name === "bash") {
    const preview = trimmed.split("\n")[0]?.slice(0, 80) ?? "";
    return `${name.padEnd(6)}${chalk.dim(preview)}`;
  }
  if (name === "write") {
    return `${name.padEnd(6)}${chalk.dim("written")}`;
  }

  const preview = trimmed.replace(/\n/g, " ").slice(0, 100);
  return `${name.padEnd(6)}${chalk.dim(preview)}`;
}
