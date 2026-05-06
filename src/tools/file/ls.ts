import { readdir, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import type { Tool } from "../base.js";

export const lsTool: Tool = {
  name: "ls",
  readonly: true,
  description:
    "List directory contents with file type and size. Use for directory exploration; use glob when you need pattern matching.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Directory path to list (defaults to current working directory)",
      },
    },
    required: [],
  },
  async execute({ path: dirPath }) {
    const absPath = resolve((dirPath as string | undefined) ?? process.cwd());
    try {
      const entries = await readdir(absPath, { withFileTypes: true });
      const results = await Promise.all(
        entries.map(async (entry) => {
          const type = entry.isDirectory() ? "dir" : "file";
          let size = "";
          if (entry.isFile()) {
            try {
              const s = await stat(join(absPath, entry.name));
              size = `${s.size}`;
            } catch {
              size = "?";
            }
          }
          return { name: entry.name, type, size };
        }),
      );
      results.sort((a, b) => {
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      const lines = results.map((e) =>
        e.type === "dir" ? `${e.name}/` : `${e.name} (${e.size} bytes)`,
      );
      return { success: true, output: lines.join("\n") || "(empty directory)" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: "", error: message };
    }
  },
};
