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
import { homedir } from "node:os";
import chalk from "chalk";

// ── Types ────────────────────────────────────────────────────────────────────

export interface SlashCommand {
  name: string;
  description: string;
}

// ── History persistence ───────────────────────────────────────────────────────

const HISTORY_FILE = join(homedir(), ".gemini-agent", "history");
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
    await mkdir(join(homedir(), ".gemini-agent"), { recursive: true });
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
  let out = "";
  for (let i = 0; i < matches.length; i++) {
    const { name, description } = matches[i];
    const nameStr = ("/" + name).padEnd(maxName);
    const selected = i === selectedIdx;
    const line = selected
      ? chalk.bgBlue.bold.white(`  ${nameStr}  ${description.slice(0, 40)}  `)
      : `  ${chalk.bold(nameStr)}  ${chalk.dim(description.slice(0, 40))}`;
    out += "\n" + line;
  }
  return out;
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
  if (stdin.isTTY) stdin.setRawMode(true);

  return new Promise((resolve) => {
    let input = "";
    let histIdx = -1; // -1 = live input; ≥0 = browsing history
    let savedInput = ""; // snapshot of live input while browsing history
    let selectedIdx = -1; // popup selection; -1 = none
    let prevPopupLines = 0; // how many popup lines were drawn last render

    // ── render ──────────────────────────────────────────────────────────────
    const render = () => {
      const matches = input.startsWith("/") ? filterCommands(commands, input) : [];

      let out = "";

      // Move back up to the prompt line and erase everything below it
      if (prevPopupLines > 0) out += A.up(prevPopupLines);
      out += A.clearLine + A.clearDown;

      // Draw prompt + current input
      out += PROMPT + input;

      // Draw popup (if any)
      const popupStr = renderPopup(matches, selectedIdx);
      out += popupStr;

      // Reposition cursor back on the input line at end of input
      if (matches.length > 0) {
        out += A.up(matches.length);
        out += "\r" + A.right(PROMPT_STR.length + input.length);
      }

      prevPopupLines = matches.length;
      stdout.write(out);
    };

    // ── cleanup ──────────────────────────────────────────────────────────────
    const done = (result: string | null) => {
      // Clear popup, end on a fresh line
      if (prevPopupLines > 0) {
        stdout.write(A.up(prevPopupLines) + A.clearLine + A.clearDown + PROMPT + input);
      }
      stdout.write("\n");
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.removeListener("keypress", onKey);
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
          selectedIdx = -1;
          prevPopupLines = 0;
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
          selectedIdx = -1;
          prevPopupLines = 0;
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
          // Navigate popup upward
          selectedIdx = selectedIdx <= 0 ? 0 : selectedIdx - 1;
        } else {
          // History: go back
          if (histIdx === -1) savedInput = input;
          if (histIdx < history.length - 1) {
            histIdx++;
            input = history[histIdx];
          }
        }
        render();
        return;
      }

      // Down arrow
      if (key.name === "down") {
        if (matches.length > 0 && selectedIdx >= 0) {
          // Navigate popup downward
          selectedIdx = Math.min(matches.length - 1, selectedIdx + 1);
        } else {
          // History: go forward
          if (histIdx > 0) {
            histIdx--;
            input = history[histIdx];
          } else if (histIdx === 0) {
            histIdx = -1;
            input = savedInput;
          }
        }
        render();
        return;
      }

      // Ctrl+A → beginning of line
      if (key.ctrl && key.name === "a") {
        render(); // cursor is always at end for now; just re-render
        return;
      }

      // Ctrl+E → end of line (no-op, cursor is always at end)
      if (key.ctrl && key.name === "e") {
        render();
        return;
      }

      // Ctrl+U → clear entire line
      if (key.ctrl && key.name === "u") {
        input = "";
        selectedIdx = -1;
        histIdx = -1;
        render();
        return;
      }

      // Ctrl+W → delete last word
      if (key.ctrl && key.name === "w") {
        const trimmed = input.trimEnd();
        const lastSpace = trimmed.lastIndexOf(" ");
        input = lastSpace >= 0 ? trimmed.slice(0, lastSpace + 1) : "";
        selectedIdx = -1;
        render();
        return;
      }

      // Backspace
      if (key.name === "backspace") {
        if (input.length > 0) {
          input = input.slice(0, -1);
          selectedIdx = -1;
        }
        render();
        return;
      }

      // Printable characters (ignore other control sequences)
      if (key.sequence && !key.ctrl && !key.meta && visLen(key.sequence) === 1) {
        input += key.sequence;
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
