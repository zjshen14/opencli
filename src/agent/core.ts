import type { GeminiClient } from "../model/gemini.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { SkillRegistry } from "../skills/registry.js";
import { toolToFunctionDeclaration, activateSkillDeclaration } from "../model/schema.js";
import { ContextManager } from "./context.js";
import { executeCalls } from "./executor.js";
import type { FunctionCallPart, Message } from "../model/types.js";

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: string }
  | { type: "skill_activated"; name: string }
  | { type: "done" };

export class Agent {
  private context: ContextManager;

  constructor(
    private gemini: GeminiClient,
    private tools: ToolRegistry,
    private skills: SkillRegistry,
    systemInstruction?: string,
  ) {
    this.context = new ContextManager(systemInstruction);
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
    // Add user message to history
    this.context.addMessage({
      role: "user",
      parts: [{ type: "text", text: userInput }],
    });

    const functionDeclarations = [
      ...this.tools.all().map(toolToFunctionDeclaration),
      activateSkillDeclaration,
    ];

    // Agentic loop: keep going until Gemini returns a final text response with no function calls
    while (true) {
      const pendingCalls: FunctionCallPart[] = [];
      let responseText = "";

      // Stream response from Gemini
      // Pass functionDeclarations to getSystemInstruction so tool names are embedded
      // in the static prefix, maximising implicit cache hits across turns.
      for await (const event of this.gemini.stream(
        this.context.getMessages(),
        this.context.getSystemInstruction(functionDeclarations),
        functionDeclarations,
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

      // Record assistant turn in history
      const assistantParts: Message["parts"] = [];
      if (responseText) assistantParts.push({ type: "text", text: responseText });
      assistantParts.push(...pendingCalls);
      if (assistantParts.length > 0) {
        this.context.addMessage({ role: "model", parts: assistantParts });
      }

      // No function calls → final response, we're done
      if (pendingCalls.length === 0) {
        yield { type: "done" };
        return;
      }

      // Execute all calls, then feed results back
      const { results } = await executeCalls(pendingCalls, {
        tools: this.tools,
        skills: this.skills,
        context: this.context,
      });

      // Emit events and record results in history
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
