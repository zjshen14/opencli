/**
 * Raw-mode input handler with per-keystroke slash command popup and history.
 *
 * Replaces readline.question() so we can intercept every keystroke before the
 * line is submitted — necessary for the live-filtering popup.
 *
 * Rendering model:
 *   - Everything is written to process.stdout (same stream as model output).
 *   - On each state change: move cursor up `prevPopupLines` rows, erase from
 *     there to end of screen (\x1b[J), redraw prompt + input + popup.
 *   - After drawing popup lines, move cursor back up to the input row so the
 *     user's insertion point stays visually correct.
 */

import { emitKeypressEvents } from "node:readline";
import { stdin, stdout } from "node:process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import chalk from "chalk";
import { AGENT_DIR } from "../state/config.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface SlashCommand {
  name: string;
  description: string;
}

// ── History persistence ───────────────────────────────────────────────────────

const HISTORY_FILE = join(AGENT_DIR, "history");
const MAX_HISTORY = 500;

export async function loadHistory(): Promise<string[]> {
  try {
    const raw = await readFile(HISTORY_FILE, "utf8");
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .reverse(); // file is oldest-first; return newest-first (readline convention)
  } catch {
    return [];
  }
}

export async function saveHistory(history: string[]): Promise<void> {
  try {
    await mkdir(AGENT_DIR, { recursive: true });
    // Write oldest-first, cap at MAX_HISTORY
    const lines = [...history].reverse().slice(-MAX_HISTORY).join("\n") + "\n";
    await writeFile(HISTORY_FILE, lines, "utf8");
  } catch {
    // Non-fatal — history just won't persist
  }
}

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const A = {
  clearLine: "\r\x1b[K",
  clearDown: "\x1b[J",
  up: (n: number) => (n > 0 ? `\x1b[${n}A` : ""),
  right: (n: number) => (n > 0 ? `\x1b[${n}C` : ""),
};

// ── Cursor-aware string helpers ───────────────────────────────────────────────

export function insertAtCursor(
  input: string,
  cursorPos: number,
  char: string,
): { input: string; cursorPos: number } {
  return {
    input: input.slice(0, cursorPos) + char + input.slice(cursorPos),
    cursorPos: cursorPos + char.length,
  };
}

export function deleteBeforeCursor(
  input: string,
  cursorPos: number,
): { input: string; cursorPos: number } {
  if (cursorPos === 0) return { input, cursorPos };
  return {
    input: input.slice(0, cursorPos - 1) + input.slice(cursorPos),
    cursorPos: cursorPos - 1,
  };
}

export function deleteWordBeforeCursor(
  input: string,
  cursorPos: number,
): { input: string; cursorPos: number } {
  const before = input.slice(0, cursorPos);
  const after = input.slice(cursorPos);
  const trimmed = before.trimEnd();
  const lastSpace = trimmed.lastIndexOf(" ");
  const newBefore = lastSpace >= 0 ? trimmed.slice(0, lastSpace + 1) : "";
  return { input: newBefore + after, cursorPos: newBefore.length };
}

// Visible length of a string (strips ANSI escape codes)
// eslint-disable-next-line no-control-regex
const visLen = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

// ── Popup rendering ───────────────────────────────────────────────────────────

const MAX_POPUP = 8;
const PROMPT_STR = "› "; // visible prompt (2 chars)
const PROMPT = chalk.green(PROMPT_STR);

function filterCommands(commands: SlashCommand[], input: string): SlashCommand[] {
  const q = input.slice(1).toLowerCase(); // strip leading "/"
  if (!q) return commands.slice(0, MAX_POPUP);
  return commands.filter((c) => c.name.toLowerCase().startsWith(q)).slice(0, MAX_POPUP);
}

function renderPopup(matches: SlashCommand[], selectedIdx: number): string {
  if (matches.length === 0) return "";
  const maxName = Math.max(...matches.map((c) => c.name.length + 1)); // +1 for "/"
  const termWidth = stdout.columns ?? 100;
  // indent(2) + name + sep(2) + description + trailing(2 for selected padding)
  const descWidth = Math.max(20, termWidth - 2 - maxName - 2 - 2);
  let out = "";
  for (let i = 0; i < matches.length; i++) {
    const { name, description } = matches[i];
    const nameStr = ("/" + name).padEnd(maxName);
    const desc = description.slice(0, descWidth);
    const selected = i === selectedIdx;
    const line = selected
      ? chalk.bgBlue.bold.white(`  ${nameStr}  ${desc}  `)
      : `  ${chalk.bold(nameStr)}  ${chalk.dim(desc)}`;
    out += "\n" + line;
  }
  return out;
}

// ── Select widget ─────────────────────────────────────────────────────────────

export interface SelectOption {
  key: string;
  label: string;
}

export function renderSelectOptions(options: SelectOption[], selectedIdx: number): string {
  let out = "";
  for (let i = 0; i < options.length; i++) {
    const { key, label } = options[i];
    const line = `  ${i === selectedIdx ? "›" : " "} ${label}  [${key}]`;
    out += (i === selectedIdx ? chalk.bold(line) : chalk.dim(line)) + "\n";
  }
  return out;
}

/**
 * Display a menu and return the key of the chosen option, or null on Escape/Ctrl+D.
 * - Pressing the option's single-character key selects immediately (no Enter).
 * - Up / Down arrows navigate; Enter confirms the highlighted item.
 * - Escape / Ctrl+D returns null (caller treats as cancel).
 * - Ctrl+C exits the process.
 */
export async function selectKey(prompt: string, options: SelectOption[]): Promise<string | null> {
  emitKeypressEvents(stdin);
  stdin.ref();
  if (stdin.isTTY) stdin.setRawMode(true);

  // 1 prompt line + 1 blank line + N option lines; guard against prompt wrapping
  // by stripping newlines — callers must keep prompts to a single line.
  const safePrompt = prompt.replace(/\n/g, " ");
  const LINES = 2 + options.length;

  return new Promise((resolve) => {
    let selectedIdx = 0;
    let rendered = false;

    const render = () => {
      let out = "";
      if (rendered) {
        out += A.up(LINES) + A.clearDown;
      }
      rendered = true;
      out += chalk.cyan("  " + safePrompt) + "\n";
      out += "\n";
      out += renderSelectOptions(options, selectedIdx);
      stdout.write(out);
    };

    const done = (result: string | null) => {
      stdout.write(A.up(LINES) + A.clearDown);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.removeListener("keypress", onKey);
      stdin.unref();
      resolve(result);
    };

    const onKey = (
      _str: string,
      key: { name: string; ctrl: boolean; meta: boolean; sequence: string },
    ) => {
      if (!key) return;

      if (key.ctrl && key.name === "c") {
        stdout.write("\n");
        if (stdin.isTTY) stdin.setRawMode(false);
        stdin.removeListener("keypress", onKey);
        process.exit(0);
      }

      if (key.name === "escape" || (key.ctrl && key.name === "d")) {
        done(null);
        return;
      }

      if (key.name === "return" || key.name === "enter") {
        done(options[selectedIdx].key);
        return;
      }

      if (key.name === "up") {
        selectedIdx = Math.max(0, selectedIdx - 1);
        render();
        return;
      }

      if (key.name === "down") {
        selectedIdx = Math.min(options.length - 1, selectedIdx + 1);
        render();
        return;
      }

      // Single-keypress shortcut — match against option keys
      if (key.sequence && !key.ctrl && !key.meta) {
        const pressed = key.sequence.toLowerCase();
        const match = options.findIndex((o) => o.key.toLowerCase() === pressed);
        if (match >= 0) {
          done(options[match].key);
          return;
        }
      }
    };

    stdin.on("keypress", onKey);
    render();
  });
}

// ── Main readLine ─────────────────────────────────────────────────────────────

/**
 * Read a line of input in raw mode.
 * Returns the submitted string, or null on EOF (Ctrl+D on empty line).
 */
export async function readLine(
  history: string[],
  commands: SlashCommand[],
): Promise<string | null> {
  emitKeypressEvents(stdin);
  stdin.ref(); // ensure the event loop stays alive while waiting for input
  if (stdin.isTTY) stdin.setRawMode(true);

  return new Promise((resolve) => {
    let input = "";
    let cursorPos = 0; // insertion point; 0 = start, input.length = end
    let histIdx = -1; // -1 = live input; ≥0 = browsing history
    let savedInput = ""; // snapshot of live input while browsing history
    let selectedIdx = -1; // popup selection; -1 = none

    // ── render ──────────────────────────────────────────────────────────────
    // Invariant: the cursor is ALWAYS on the prompt line when render() is
    // called — either because no popup was shown, or because we moved it
    // back up after drawing the popup. So we never need to move up first;
    // clearLine + clearDown is enough to erase the prompt and any popup
    // lines that may still be visible below it.
    const render = () => {
      const matches = input.startsWith("/") ? filterCommands(commands, input) : [];

      let out = A.clearLine + A.clearDown;

      // Draw prompt + current input
      out += PROMPT + input;

      // Draw popup (if any)
      out += renderPopup(matches, selectedIdx);

      // Reposition cursor on the prompt line at cursorPos
      if (matches.length > 0) {
        out += A.up(matches.length);
      }
      out += "\r" + A.right(PROMPT_STR.length + cursorPos);

      stdout.write(out);
    };

    // ── cleanup ──────────────────────────────────────────────────────────────
    const done = (result: string | null) => {
      // Cursor is on the prompt line; clear any popup below and finalise
      stdout.write(A.clearLine + A.clearDown + PROMPT + input + "\n");
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.removeListener("keypress", onKey);
      stdin.unref(); // don't keep the event loop alive after the REPL exits
      resolve(result);
    };

    // ── keypress handler ─────────────────────────────────────────────────────
    const onKey = (
      _str: string,
      key: { name: string; ctrl: boolean; meta: boolean; sequence: string },
    ) => {
      if (!key) return;

      const matches = input.startsWith("/") ? filterCommands(commands, input) : [];

      // Ctrl+C → exit
      if (key.ctrl && key.name === "c") {
        stdout.write("\n");
        if (stdin.isTTY) stdin.setRawMode(false);
        stdin.removeListener("keypress", onKey);
        process.exit(0);
      }

      // Ctrl+D on empty input → EOF
      if (key.ctrl && key.name === "d" && input === "") {
        done(null);
        return;
      }

      // Enter → submit (or select popup item)
      if (key.name === "return" || key.name === "enter") {
        if (selectedIdx >= 0 && matches[selectedIdx]) {
          // Complete the selected slash command
          input = "/" + matches[selectedIdx].name + " ";
          cursorPos = input.length;
          selectedIdx = -1;
          render();
          return;
        }
        done(input);
        return;
      }

      // Tab → accept top popup match
      if (key.name === "tab" && matches.length > 0) {
        const pick = selectedIdx >= 0 ? matches[selectedIdx] : matches[0];
        if (pick) {
          input = "/" + pick.name + " ";
          cursorPos = input.length;
          selectedIdx = -1;
        }
        render();
        return;
      }

      // Escape → dismiss popup
      if (key.name === "escape") {
        selectedIdx = -1;
        render();
        return;
      }

      // Up arrow
      if (key.name === "up") {
        if (matches.length > 0) {
          // Navigate popup upward; pressing Up past the top deselects
          selectedIdx = selectedIdx <= 0 ? -1 : selectedIdx - 1;
        } else {
          // History: go back
          if (histIdx === -1) savedInput = input;
          if (histIdx < history.length - 1) {
            histIdx++;
            input = history[histIdx];
            cursorPos = input.length;
          }
        }
        render();
        return;
      }

      // Down arrow
      if (key.name === "down") {
        if (matches.length > 0) {
          // Popup visible: start selection or move down
          selectedIdx = selectedIdx < 0 ? 0 : Math.min(matches.length - 1, selectedIdx + 1);
        } else {
          // History: go forward
          if (histIdx > 0) {
            histIdx--;
            input = history[histIdx];
            cursorPos = input.length;
          } else if (histIdx === 0) {
            histIdx = -1;
            input = savedInput;
            cursorPos = input.length;
          }
        }
        render();
        return;
      }

      // Left arrow → move cursor left
      if (key.name === "left") {
        if (cursorPos > 0) cursorPos--;
        render();
        return;
      }

      // Right arrow → move cursor right
      if (key.name === "right") {
        if (cursorPos < input.length) cursorPos++;
        render();
        return;
      }

      // Ctrl+A → beginning of line
      if (key.ctrl && key.name === "a") {
        cursorPos = 0;
        render();
        return;
      }

      // Ctrl+E → end of line
      if (key.ctrl && key.name === "e") {
        cursorPos = input.length;
        render();
        return;
      }

      // Ctrl+U → clear entire line
      if (key.ctrl && key.name === "u") {
        input = "";
        cursorPos = 0;
        selectedIdx = -1;
        histIdx = -1;
        render();
        return;
      }

      // Ctrl+W → delete word before cursor
      if (key.ctrl && key.name === "w") {
        ({ input, cursorPos } = deleteWordBeforeCursor(input, cursorPos));
        selectedIdx = -1;
        render();
        return;
      }

      // Backspace → delete character before cursor
      if (key.name === "backspace") {
        ({ input, cursorPos } = deleteBeforeCursor(input, cursorPos));
        selectedIdx = -1;
        render();
        return;
      }

      // Printable characters (ignore other control sequences)
      if (key.sequence && !key.ctrl && !key.meta && visLen(key.sequence) === 1) {
        ({ input, cursorPos } = insertAtCursor(input, cursorPos, key.sequence));
        selectedIdx = -1;
        render();
        return;
      }
    };

    stdin.on("keypress", onKey);

    // Initial render
    render();
  });
}
