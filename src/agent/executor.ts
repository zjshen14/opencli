import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { FunctionCallPart, FunctionResultPart } from "../model/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { ContextManager } from "./context.js";

// Tools whose output is truncated when it exceeds the limit.
// read is excluded — it supports offset/limit pagination and agents rely on
// exact line spans for follow-up edit calls.
const TRUNCATE_TOOLS = new Set(["bash", "grep", "glob"]);
const DEFAULT_MAX_OUTPUT = 20_000;

// Tools blocked when `readOnly` is set on ExecutorDeps (used by plan mode).
// Defence-in-depth: even if the filtered tool list leaks, the executor refuses.
const WRITE_TOOLS = new Set(["write", "edit", "bash"]);

export interface ExecutorDeps {
  tools: ToolRegistry;
  skills: SkillRegistry;
  context: ContextManager;
  tmpDir?: string;
  readOnly?: boolean;
}

export function truncateOutput(output: string, callId: string, tmpDir?: string): string {
  const max = parseInt(process.env.OPENCLI_MAX_TOOL_OUTPUT ?? String(DEFAULT_MAX_OUTPUT));
  if (output.length <= max) return output;

  const head = Math.floor(max * 0.3);
  const tail = max - head;

  let savedNote = "";
  if (tmpDir) {
    try {
      mkdirSync(tmpDir, { recursive: true });
      const savedPath = join(tmpDir, `tool-output-${callId}.txt`);
      writeFileSync(savedPath, output);
      savedNote = ` Full output saved to ${savedPath}.`;
    } catch {
      // non-fatal — truncation message still lands in context
    }
  }

  return (
    output.slice(0, head) +
    `\n\n[... ${output.length - max} chars truncated.${savedNote} ...]\n\n` +
    output.slice(-tail)
  );
}

export interface ExecutionResult {
  results: FunctionResultPart[];
  // Skill activations return no tool result — they mutate context directly
}

async function executeOneCall(
  call: FunctionCallPart,
  deps: ExecutorDeps,
): Promise<FunctionResultPart> {
  if (deps.readOnly && WRITE_TOOLS.has(call.name)) {
    return {
      type: "function_result",
      id: call.id,
      name: call.name,
      result: `Error: '${call.name}' is blocked in plan mode. Use read, glob, or grep to explore the codebase.`,
      thoughtSignature: call.thoughtSignature,
    };
  }
  const result = await deps.tools.execute(call.name, call.args as Record<string, unknown>);
  const raw = result.error ? `Error: ${result.error}` : result.output || "(no output)";
  const output = TRUNCATE_TOOLS.has(call.name) ? truncateOutput(raw, call.id, deps.tmpDir) : raw;
  return {
    type: "function_result",
    id: call.id,
    name: call.name,
    result: output,
    thoughtSignature: call.thoughtSignature,
  };
}

export async function executeCalls(
  calls: FunctionCallPart[],
  deps: ExecutorDeps,
): Promise<ExecutionResult> {
  // Separate skill activations from regular tool calls
  const skillCalls = calls.filter((c) => c.name === "activate_skill");
  const toolCalls = calls.filter((c) => c.name !== "activate_skill");

  // Handle skill activations (context mutation, no tool result needed)
  for (const call of skillCalls) {
    const name = call.args.name as string;
    if (!deps.context.hasSkill(name)) {
      const body = await deps.skills.load(name);
      if (body) {
        deps.context.addSkillContent(name, body);
      }
    }
  }

  // If any call mutates state, execute all sequentially in declared order to
  // prevent race conditions (e.g. two edits to the same file, or a write
  // followed by a read that depends on it). Pure read batches still run in
  // parallel for speed.
  let results: FunctionResultPart[];
  if (toolCalls.some((c) => WRITE_TOOLS.has(c.name))) {
    results = [];
    for (const call of toolCalls) {
      results.push(await executeOneCall(call, deps));
    }
  } else {
    results = await Promise.all(toolCalls.map((call) => executeOneCall(call, deps)));
  }

  return { results };
}
