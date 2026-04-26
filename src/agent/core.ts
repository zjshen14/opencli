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
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: string }
  | { type: "skill_activated"; name: string }
  | { type: "error"; message: string }
  | { type: "done" };

const DEFAULT_MAX_TURNS = 50;
const STUCK_THRESHOLD = 3;

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

  async *run(userInput: string): AsyncGenerator<AgentEvent> {
    this.context.addMessage({
      role: "user",
      parts: [{ type: "text", text: userInput }],
    });

    const toolDefinitions = [...this.tools.all().map(toolToDefinition), activateSkillDefinition];

    let turns = 0;
    let lastCallSig = "";
    let stuckCount = 0;

    while (true) {
      const pendingCalls: FunctionCallPart[] = [];
      let responseText = "";

      for await (const event of this.client.stream(
        this.context.getMessages(),
        this.context.getSystemInstruction(toolDefinitions),
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
          yield { type: "tool_call", name: event.name, args: event.args };
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
