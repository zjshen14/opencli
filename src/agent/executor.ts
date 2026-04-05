import type { FunctionCallPart, FunctionResultPart } from "../model/types.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { ContextManager } from "./context.js";

export interface ExecutorDeps {
  tools: ToolRegistry;
  skills: SkillRegistry;
  context: ContextManager;
}

export interface ExecutionResult {
  results: FunctionResultPart[];
  // Skill activations return no tool result — they mutate context directly
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

  // Execute all tool calls in parallel
  const results = await Promise.all(
    toolCalls.map(async (call): Promise<FunctionResultPart> => {
      const result = await deps.tools.execute(call.name, call.args as Record<string, unknown>);
      return {
        type: "function_result",
        id: call.id,
        name: call.name,
        result: result.error ? `Error: ${result.error}` : result.output || "(no output)",
        thoughtSignature: call.thoughtSignature,
      };
    }),
  );

  return { results };
}
