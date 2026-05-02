import { readFile, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { Tool } from "../base.js";

export const editTool: Tool = {
  name: "edit",
  description:
    "Replace an exact string in a file. old_string must appear exactly once in the file. Use read first to confirm the exact content.",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to the file to edit" },
      old_string: { type: "string", description: "The exact string to find and replace" },
      new_string: { type: "string", description: "The replacement string" },
    },
    required: ["file_path", "old_string", "new_string"],
  },
  requiresConfirmation(args): boolean {
    const absPath = resolve(args.file_path as string);
    const cwd = process.cwd();
    return !(absPath === cwd || absPath.startsWith(cwd + sep));
  },
  async execute({ file_path, old_string, new_string }) {
    const absPath = resolve(file_path as string);
    let content: string;
    try {
      content = await readFile(absPath, "utf8");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: "", error: message };
    }

    const oldStr = old_string as string;
    const count = content.split(oldStr).length - 1;
    if (count === 0) {
      return { success: false, output: "", error: "old_string not found in file" };
    }
    if (count > 1) {
      return {
        success: false,
        output: "",
        error: `old_string found ${count} times — provide more surrounding context to make it unique`,
      };
    }

    const updated = content.replace(oldStr, new_string as string);
    try {
      await writeFile(absPath, updated, "utf8");
      return { success: true, output: `Edited ${absPath}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: "", error: message };
    }
  },
};
