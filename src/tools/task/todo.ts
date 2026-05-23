import { readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import type { Tool } from "../base.js";

interface TodoItem {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "done";
}

// Each process run (= one CLI session) gets its own todo file.
const TODO_PATH = join(tmpdir(), `opencli-todo-${process.pid}.json`);

export const todoWriteTool: Tool = {
  name: "todo_write",
  description:
    "Write the session task list. Use to track multi-step work: create items at the start of a task, update status as you complete each step. Each item needs a unique id, text, and status (pending/in_progress/done). Replaces the entire list on every call.",
  parameters: {
    type: "object",
    properties: {
      items: {
        type: "array",
        description: "Full list of todo items for this session",
        items: {
          type: "object",
          properties: {
            id: { type: "string", description: "Unique identifier, e.g. '1', '2a'" },
            text: { type: "string", description: "Task description" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "done"],
              description: "Current status",
            },
          },
          required: ["id", "text", "status"],
        },
      },
    },
    required: ["items"],
  },
  async execute({ items }) {
    try {
      await mkdir(dirname(TODO_PATH), { recursive: true });
      await writeFile(TODO_PATH, JSON.stringify(items, null, 2), "utf8");
      const typed = items as TodoItem[];
      const list = typed.map((it) => `[${statusIcon(it.status)}] ${it.id}. ${it.text}`).join("\n");
      // Why: agents often emit a summary and stop after marking 1-2 items done,
      // leaving the rest of a multi-step task incomplete. The pending footer is
      // appended to the tool result so the model sees the unfinished work on
      // its next turn and either continues or explicitly states why it's stopping.
      const pending = typed.filter((it) => it.status === "pending");
      const footer = pending.length > 0 ? pendingFooter(pending) : "";
      return { success: true, output: (list || "(empty list)") + footer };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: "", error: message };
    }
  },
};

function pendingFooter(pending: TodoItem[]): string {
  const lines = pending.map((it) => `  - [${it.id}] ${it.text}`).join("\n");
  return (
    `\n\n${pending.length} pending item(s) remaining:\n${lines}\n\n` +
    `Continue with the next pending item. Only stop if the user has redirected you, ` +
    `a pending item is blocked on input you need, or all remaining items are out of scope — ` +
    `and in those cases, say so explicitly before stopping.`
  );
}

export const todoReadTool: Tool = {
  name: "todo_read",
  readonly: true,
  description:
    "Read the current session task list written by todo_write. Use to check progress before continuing a multi-step task.",
  parameters: {
    type: "object",
    properties: {},
    required: [],
  },
  async execute() {
    try {
      const raw = await readFile(TODO_PATH, "utf8");
      const items = JSON.parse(raw) as TodoItem[];
      const list = items.map((it) => `[${statusIcon(it.status)}] ${it.id}. ${it.text}`).join("\n");
      return { success: true, output: list || "(empty list)" };
    } catch {
      return { success: true, output: "(no tasks yet)" };
    }
  },
};

function statusIcon(status: TodoItem["status"]): string {
  if (status === "done") return "x";
  if (status === "in_progress") return "~";
  return " ";
}
