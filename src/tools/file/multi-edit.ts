import { resolve, sep } from "node:path";
import type { Tool } from "../base.js";

export const multiEditTool: Tool = {
  name: "multi_edit",
  description:
    "Apply multiple sequential edits to a file as a single confirmed operation. " +
    "Each edit's old_string must appear exactly once in the file at the time it is applied. " +
    "Edits are applied in order; if any edit fails, the operation stops at that point " +
    "(earlier edits are NOT rolled back — use /rewind or git to undo the partial state).",
  composedOf: ["edit"],
  singleConfirmation: true,
  parameters: {
    type: "object",
    properties: {
      file_path: { type: "string", description: "Path to the file to edit" },
      edits: {
        type: "array",
        description: "Ordered list of edits to apply",
        items: {
          type: "object",
          properties: {
            old_string: { type: "string", description: "Exact string to find and replace" },
            new_string: { type: "string", description: "Replacement string" },
          },
          required: ["old_string", "new_string"],
        },
      },
    },
    required: ["file_path", "edits"],
  },
  requiresConfirmation(args): boolean {
    const absPath = resolve(args.file_path as string);
    const cwd = process.cwd();
    return !(absPath === cwd || absPath.startsWith(cwd + sep));
  },
  async execute({ file_path, edits }, ctx) {
    if (!ctx) {
      return {
        success: false,
        output: "",
        error: "multi_edit must be invoked via ToolRegistry, not called directly.",
      };
    }
    const editList = edits as Array<{ old_string: string; new_string: string }>;
    for (const edit of editList) {
      const result = await ctx.registry.execute("edit", {
        file_path,
        old_string: edit.old_string,
        new_string: edit.new_string,
      });
      if (!result.success) return result;
    }
    return {
      success: true,
      output: `Applied ${editList.length} edit${editList.length === 1 ? "" : "s"} to ${resolve(file_path as string)}`,
    };
  },
};
