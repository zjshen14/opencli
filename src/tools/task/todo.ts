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
      const list = (items as TodoItem[])
        .map((it) => `[${statusIcon(it.status)}] ${it.id}. ${it.text}`)
        .join("\n");
      return { success: true, output: list || "(empty list)" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: "", error: message };
    }
  },
};

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
