import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Tool } from "../base.js";

export const grepTool: Tool = {
  name: "grep",
  description:
    "Search for a regex pattern in file contents. Returns matching lines with file path and line number.",
  parameters: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "Regular expression pattern to search for" },
      path: { type: "string", description: "File or directory to search (defaults to cwd)" },
      glob: {
        type: "string",
        description: "Only search files matching this glob pattern, e.g. '*.ts'",
      },
      case_insensitive: { type: "boolean" as never, description: "Case-insensitive search" },
    },
    required: ["pattern"],
  },
  async execute({ pattern, path: searchPath, glob: globFilter, case_insensitive }) {
    const baseDir = (searchPath as string | undefined) ?? process.cwd();
    const flags = case_insensitive ? "gi" : "g";
    let regex: RegExp;
    try {
      regex = new RegExp(pattern as string, flags);
    } catch {
      return { success: false, output: "", error: `Invalid regex: ${pattern}` };
    }

    const files = await collectFiles(baseDir, globFilter as string | undefined);
    const results: string[] = [];

    for (const file of files) {
      let content: string;
      try {
        content = await readFile(file, "utf8");
      } catch {
        continue;
      }
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i])) {
          results.push(`${file}:${i + 1}: ${lines[i]}`);
        }
        regex.lastIndex = 0;
      }
    }

    return {
      success: true,
      output: results.length > 0 ? results.join("\n") : "(no matches)",
    };
  },
};

async function collectFiles(dir: string, glob?: string): Promise<string[]> {
  const s = await stat(dir);
  if (s.isFile()) return [dir];

  const all: string[] = [];
  await walk(dir, all);

  if (!glob) return all;
  return all.filter((f) => {
    const name = f.split("/").pop() ?? "";
    return matchSimpleGlob(glob, name);
  });
}

async function walk(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else out.push(full);
  }
}

function matchSimpleGlob(pattern: string, name: string): boolean {
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$",
  );
  return regex.test(name);
}
