import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Tool } from "../base.js";

export const readTool: Tool = {
  name: "read",
  readonly: true,
  description:
    "Read the contents of a file. Optionally specify offset (line to start from, 1-based) and limit (number of lines to read).",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute or relative path to the file" },
      offset: { type: "number", description: "Line number to start reading from (1-based)" },
      limit: { type: "number", description: "Maximum number of lines to read" },
    },
    required: ["file_path"],
  },
  async execute({ file_path, offset, limit }) {
    const absPath = resolve(file_path as string);
    let content: string;
    try {
      content = await readFile(absPath, "utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: "", error: message };
    }

    let lines = content.split("\n");
    const startLine = offset ? Number(offset) - 1 : 0;
    if (startLine > 0) lines = lines.slice(startLine);
    if (limit) lines = lines.slice(0, Number(limit));

    // Prefix each line with its 1-based line number (matches cat -n style used by editors)
    const numbered = lines.map((line, i) => `${startLine + i + 1}\t${line}`).join("\n");
    return { success: true, output: numbered };
  },
};
