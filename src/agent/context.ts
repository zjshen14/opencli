import type { Message } from "../model/types.js";

const SYSTEM_INSTRUCTION = `You are Gemini Agent, a general-purpose AI assistant for software development tasks.
You have access to tools for reading and writing files, executing shell commands, searching codebases, and browsing the web.

Guidelines:
- Always read files before editing them
- Prefer targeted edits over full rewrites
- Ask for clarification when the request is ambiguous
- Warn before executing destructive operations
- Be concise — lead with the action, not the explanation
- Working directory: {CWD}`;

export class ContextManager {
  private history: Message[] = [];
  private skillContent: string[] = []; // activated skill bodies, never pruned
  private maxHistoryMessages = 50;

  getSystemInstruction(): string {
    return SYSTEM_INSTRUCTION.replace("{CWD}", process.cwd());
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

  clear(): void {
    this.history = [];
    this.skillContent = [];
  }

  private prune(): void {
    if (this.history.length <= this.maxHistoryMessages) return;
    // Keep the most recent messages; never prune the first user message if it has skill content
    this.history = this.history.slice(-this.maxHistoryMessages);
  }
}
