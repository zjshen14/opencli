import { writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import type { Tool } from "../base.js";

export const writeTool: Tool = {
  name: "write",
  description:
    "Write content to a file, creating it (and any missing parent directories) if needed. Overwrites existing content.",
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Absolute or relative path to the file" },
      content: { type: "string", description: "Content to write" },
    },
    required: ["file_path", "content"],
  },
  async execute({ file_path, content }) {
    const absPath = resolve(file_path as string);
    try {
      await mkdir(dirname(absPath), { recursive: true });
      await writeFile(absPath, content as string, "utf8");
      return { success: true, output: `Written to ${absPath}` };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: "", error: message };
    }
  },
};
