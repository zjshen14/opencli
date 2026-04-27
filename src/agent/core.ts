import type { LLMClient } from "../model/client.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SkillRegistry } from "../skills/registry.js";
import { toolToDefinition, activateSkillDefinition } from "../model/schema.js";
import { ContextManager } from "./context.js";
import { executeCalls } from "./executor.js";
import { buildReminder } from "./prompt.js";
import type { FunctionCallPart, Message } from "../model/types.js";

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; args: Record<string, unknown>; thoughtSignature?: string }
  | { type: "tool_result"; name: string; result: string }
  | { type: "skill_activated"; name: string }
  | { type: "error"; message: string }
  | { type: "done" };

const DEFAULT_MAX_TURNS = 50;
const STUCK_THRESHOLD = 3;

export type AgentRunMode = "react" | "plan";

// Tools exposed in plan mode — exploration only, no writes.
// Bash is excluded: read/glob/grep cover 95% of exploration, and reliably
// validating bash as read-only is hard (subshells, redirects, find -exec).
const PLAN_MODE_TOOLS = new Set(["read", "glob", "grep", "think", "activate_skill"]);

const PLAN_SYSTEM_SUFFIX = `

## Plan Mode

You are in **Plan Mode**. Your only task is to explore the codebase and produce a concrete numbered execution plan. You CANNOT and MUST NOT modify any files.

Available tools: \`read\`, \`glob\`, \`grep\`, \`think\`.
Write tools (\`write\`, \`edit\`, \`bash\`) are blocked at the executor level.

### Process

1. **Understand** — Restate the goal in one sentence. Make assumptions explicit; do not ask the user clarifying questions (flag any uncertainties in the Risks section instead).
2. **Explore** — Use glob/grep to map relevant files, then read the ones most central to the task. Follow imports as needed. Skip files you don't need.
3. **Design** — Use think to reason about the approach, constraints, and alternatives.
4. **Plan** — Output the final plan in the format below, then stop.

### Output format

## Plan: <short title>

- [ ] 1. **<step title>** — \`path/to/file.ts\` — one-line description
- [ ] 2. **<step title>** — \`path/to/file.ts\` — one-line description
- [ ] N. **Verify** — \`npm test\` (or relevant command)

### Critical files
- \`path/to/file1.ts\` — why this is central
- \`path/to/file2.ts\` — why

### Risks / assumptions
- ⚠️ <risk or unverified assumption — one line>

### Rules

- 3–10 steps for most tasks
- Each step must name a specific file path
- Use ⚠️ for any step that depends on an unverified assumption
- Do NOT include full file contents or large code blocks
- Do NOT begin execution — stop after producing the plan`;

export class Agent {
  private context: ContextManager;

  constructor(
    private client: LLMClient,
    private tools: ToolRegistry,
    private skills: SkillRegistry,
    systemInstruction?: string,
    maxHistoryMessages?: number,
    private maxTurns: number = DEFAULT_MAX_TURNS,
  ) {
    this.context = new ContextManager(systemInstruction, maxHistoryMessages);
  }

  setSessionTmpDir(dir: string): void {
    this.context.setSessionTmpDir(dir);
  }

  restoreMessages(messages: Message[]): void {
    this.context.restoreMessages(messages);
  }

  injectSkill(name: string, body: string): void {
    if (!this.context.hasSkill(name)) {
      this.context.addSkillContent(name, body);
    }
  }

  async *run(userInput: string, mode: AgentRunMode = "react"): AsyncGenerator<AgentEvent> {
    this.context.addMessage({
      role: "user",
      parts: [{ type: "text", text: userInput }],
    });

    const allToolDefs = [...this.tools.all().map(toolToDefinition), activateSkillDefinition];
    const toolDefinitions =
      mode === "plan" ? allToolDefs.filter((t) => PLAN_MODE_TOOLS.has(t.name)) : allToolDefs;

    const baseInstruction = this.context.getSystemInstruction(toolDefinitions);
    const systemInstruction =
      mode === "plan" ? baseInstruction + PLAN_SYSTEM_SUFFIX : baseInstruction;

    let turns = 0;
    let lastCallSig = "";
    let stuckCount = 0;

    while (true) {
      const pendingCalls: FunctionCallPart[] = [];
      let responseText = "";

      for await (const event of this.client.stream(
        this.context.getMessages(),
        systemInstruction,
        toolDefinitions,
      )) {
        if (event.type === "text") {
          responseText += event.text;
          yield { type: "text", text: event.text };
        } else if (event.type === "function_call") {
          pendingCalls.push({
            type: "function_call",
            id: event.id,
            name: event.name,
            args: event.args,
            thoughtSignature: event.thoughtSignature,
          });
          yield {
            type: "tool_call",
            name: event.name,
            args: event.args,
            thoughtSignature: event.thoughtSignature,
          };
        }
      }

      const assistantParts: Message["parts"] = [];
      if (responseText) assistantParts.push({ type: "text", text: responseText });
      assistantParts.push(...pendingCalls);
      if (assistantParts.length > 0) {
        this.context.addMessage({ role: "model", parts: assistantParts });
      }

      if (pendingCalls.length === 0) {
        yield { type: "done" };
        return;
      }

      // Max turns guard
      turns++;
      if (turns > this.maxTurns) {
        yield {
          type: "error",
          message: `Reached maximum iterations (${this.maxTurns}). Try breaking the task into smaller steps.`,
        };
        return;
      }

      // Stuck-loop detection: same tool(s) + same args N times in a row
      const sig = JSON.stringify(pendingCalls.map((c) => ({ name: c.name, args: c.args })));
      if (sig === lastCallSig) {
        stuckCount++;
        if (stuckCount >= STUCK_THRESHOLD) {
          yield {
            type: "error",
            message: `Detected ${STUCK_THRESHOLD} identical tool calls in a row — stopping to avoid a loop.`,
          };
          return;
        }
      } else {
        lastCallSig = sig;
        stuckCount = 1;
      }

      const { results } = await executeCalls(pendingCalls, {
        tools: this.tools,
        skills: this.skills,
        context: this.context,
        tmpDir: this.context.getSessionTmpDir(),
        readOnly: mode === "plan",
      });

      // Append an event-driven reminder to the last tool result based on what
      // tools just ran — fires only when relevant (e.g. edit → "run tests").
      const reminder = buildReminder(pendingCalls.map((c) => ({ name: c.name, args: c.args })));
      if (reminder && results.length > 0) {
        results[results.length - 1] = {
          ...results[results.length - 1],
          result: results[results.length - 1].result + reminder,
        };
      }

      const skillCalls = pendingCalls.filter((c) => c.name === "activate_skill");
      for (const call of skillCalls) {
        yield { type: "skill_activated", name: call.args.name as string };
      }

      for (const result of results) {
        yield { type: "tool_result", name: result.name, result: result.result };
      }

      if (results.length > 0) {
        this.context.addMessage({
          role: "user",
          parts: results,
        });
      }
    }
  }

  clearHistory(): void {
    this.context.clear();
  }
}
