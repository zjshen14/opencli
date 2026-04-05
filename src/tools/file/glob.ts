import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Tool } from "../base.js";

export const globTool: Tool = {
  name: "glob",
  description:
    "Find files matching a glob pattern. Returns matching file paths sorted by modification time.",
  parameters: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Glob pattern, e.g. '**/*.ts' or 'src/**/*.test.ts'",
      },
      path: {
        type: "string",
        description: "Directory to search in (defaults to current working directory)",
      },
    },
    required: ["pattern"],
  },
  async execute({ pattern, path: searchPath }) {
    const baseDir = (searchPath as string | undefined) ?? process.cwd();
    try {
      const allFiles = await walk(baseDir);
      const matched = allFiles.filter((f) => matchGlob(pattern as string, relative(baseDir, f)));

      // Sort by modification time (newest first)
      const withMtime = await Promise.all(
        matched.map(async (f) => ({ path: f, mtime: (await stat(f)).mtimeMs })),
      );
      withMtime.sort((a, b) => b.mtime - a.mtime);

      const output = withMtime.map((f) => f.path).join("\n");
      return { success: true, output: output || "(no matches)" };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, output: "", error: message };
    }
  },
};

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await walk(full)));
    } else {
      results.push(full);
    }
  }
  return results;
}

// Minimal glob matcher supporting **, *, and ? wildcards
function matchGlob(pattern: string, filePath: string): boolean {
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*\*/g, "§DSTAR§")
        .replace(/\*/g, "[^/]*")
        .replace(/\?/g, "[^/]")
        .replace(/§DSTAR§\//g, "(?:.+/)?")
        .replace(/§DSTAR§/g, ".*") +
      "$",
  );
  return regex.test(filePath);
}
