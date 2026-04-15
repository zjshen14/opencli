import type { Message } from "../model/types.js";
import type { FunctionDeclaration } from "@google/genai";
import { DEFAULT_SYSTEM_INSTRUCTION } from "./prompt.js";

export class ContextManager {
  private history: Message[] = [];
  private skillContent: string[] = []; // activated skill bodies, never pruned
  private maxHistoryMessages = 50;
  private sessionTmpDir: string | undefined = undefined;
  private cachedSystemInstruction: string | null = null;
  private cachedToolSignature: string | null = null;

  constructor(private readonly systemInstructionTemplate = DEFAULT_SYSTEM_INSTRUCTION) {}

  setSessionTmpDir(dir: string): void {
    this.sessionTmpDir = dir;
    this.cachedSystemInstruction = null;
    this.cachedToolSignature = null;
  }

  getSystemInstruction(tools: FunctionDeclaration[] = []): string {
    const signature = tools.map((t) => t.name).join(",");
    if (this.cachedSystemInstruction && this.cachedToolSignature === signature) {
      return this.cachedSystemInstruction;
    }

    const toolCatalog =
      tools.length > 0
        ? `## Available Tools\n${tools.map((t) => `- ${t.name}: ${t.description ?? ""}`).join("\n")}`
        : "";

    const tmpDir = this.sessionTmpDir ?? `${process.cwd()}/.gemini-agent/tmp`;
    const rendered = this.systemInstructionTemplate
      .replace("{CWD}", process.cwd())
      .replace("{SESSION_TMP}", tmpDir)
      .replace("{TOOL_CATALOG}", toolCatalog);
    this.cachedSystemInstruction = rendered;
    this.cachedToolSignature = signature;
    return rendered;
  }

  addMessage(message: Message): void {
    this.history.push(message);
    this.prune();
  }

  addSkillContent(name: string, body: string): void {
    const tagged = `<skill_content name="${name}">\n${body}\n</skill_content>`;
    this.skillContent.push(tagged);
  }

  hasSkill(name: string): boolean {
    return this.skillContent.some((s) => s.includes(`name="${name}"`));
  }

  getMessages(): Message[] {
    if (this.skillContent.length === 0) return this.history;

    // Prepend all activated skill content as the first user message in history
    const skillBlock = this.skillContent.join("\n\n");
    const skillMessage: Message = {
      role: "user",
      parts: [{ type: "text", text: `## Active Skills\n\n${skillBlock}` }],
    };
    return [skillMessage, ...this.history];
  }

  restoreMessages(messages: Message[]): void {
    this.history = messages;
  }

  clear(): void {
    this.history = [];
    this.skillContent = [];
    this.cachedSystemInstruction = null;
    this.cachedToolSignature = null;
  }

  private prune(): void {
    if (this.history.length <= this.maxHistoryMessages) return;
    // Keep the most recent messages; never prune the first user message if it has skill content
    this.history = this.history.slice(-this.maxHistoryMessages);
  }
}
