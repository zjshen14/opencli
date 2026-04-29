import type { Message, ToolDefinition } from "../model/types.js";
import { DEFAULT_SYSTEM_INSTRUCTION, getGitContext } from "./prompt.js";

export class ContextManager {
  private history: Message[] = [];
  private skillContent: string[] = []; // activated skill bodies, never pruned
  private maxHistoryMessages: number;
  private sessionTmpDir: string | undefined = undefined;
  private cachedSystemInstruction: string | null = null;
  private cachedToolSignature: string | null = null;

  constructor(
    private readonly systemInstructionTemplate = DEFAULT_SYSTEM_INSTRUCTION,
    maxHistoryMessages = 50,
  ) {
    this.maxHistoryMessages = maxHistoryMessages;
  }

  setSessionTmpDir(dir: string): void {
    this.sessionTmpDir = dir;
    this.cachedSystemInstruction = null;
    this.cachedToolSignature = null;
  }

  getSessionTmpDir(): string | undefined {
    return this.sessionTmpDir;
  }

  getSystemInstruction(tools: ToolDefinition[] = []): string {
    const signature = tools.map((t) => t.name).join(",");
    if (this.cachedSystemInstruction && this.cachedToolSignature === signature) {
      return this.cachedSystemInstruction;
    }

    const toolCatalog =
      tools.length > 0
        ? `## Available Tools\n${tools.map((t) => `- ${t.name}: ${t.description ?? ""}`).join("\n")}`
        : "";

    const tmpDir = this.sessionTmpDir ?? `${process.cwd()}/.opencli/tmp`;
    const gitContext = getGitContext();
    const rendered = this.systemInstructionTemplate
      .replaceAll("{CWD}", process.cwd())
      .replaceAll("{SESSION_TMP}", tmpDir)
      .replaceAll("{TOOL_CATALOG}", toolCatalog)
      .replaceAll("{GIT_CONTEXT}", gitContext ? gitContext + "\n\n" : "");
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

    const sliced = this.history.slice(-this.maxHistoryMessages);

    // Advance past any orphaned messages at the head of the slice so we never
    // send a function_result without its matching function_call (Gemini returns
    // 400 Bad Request) or start with a model message (history must begin with user).
    let startIdx = 0;
    while (startIdx < sliced.length) {
      const msg = sliced[startIdx];
      if (msg.role === "user" && !msg.parts.some((p) => p.type === "function_result")) {
        break;
      }
      startIdx++;
    }

    this.history = sliced.slice(startIdx);
  }
}
