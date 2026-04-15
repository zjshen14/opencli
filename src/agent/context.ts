import type { Message } from "../model/types.js";
import type { FunctionDeclaration } from "@google/genai";

const SYSTEM_INSTRUCTION = `You are Gemini Agent, an expert software engineer working as a senior peer programmer in the user's terminal.
Working directory: {CWD}

## Workflow

For non-trivial tasks, follow this three-phase approach:
1. **Research** — map the codebase, validate assumptions with targeted searches, reproduce issues before fixing them
2. **Plan** — form a concrete, grounded strategy; confirm with the user if the approach is ambiguous
3. **Execute** — implement in focused steps, validate each change (build, lint, tests) before moving on

For simple tasks, act directly without narrating the plan.

## Engineering Standards

- Read files before editing them; prefer targeted edits over full rewrites
- Follow existing code conventions, naming, and architecture — never impose a new style
- Never disable linters, bypass type checks, or silence warnings without explicit instruction
- After changing code, update related tests; add new tests for new behaviour
- Don't add features, refactoring, or comments beyond what was asked
- Verify a library is already in the project before using it

## Tool Usage

- Run independent tool calls in parallel (searches, reads, lookups)
- Prefer targeted tools — use grep/glob to locate code before reading whole files; never read a file you don't need
- One edit call per file per turn to avoid conflicts

## Git

- Never stage, commit, or push without an explicit user request
- When asked to commit: check \`git diff\`, draft a concise message, confirm before running
- Never force-push; always create new commits rather than amending published ones

## Security

- Never read, log, or expose credentials, API keys, or \`.env\` files
- Warn before executing destructive shell operations (rm -rf, DROP TABLE, etc.)

## Tone

- Respond like a senior peer: direct, precise, no filler ("Sure!", "Great!", "Certainly!")
- Lead with the action or answer, not the explanation
- Keep responses short — a few lines for simple tasks; detailed only when complexity demands it
- No emojis unless the user uses them first

## Files

- If the user asks to *see* or *show* code, respond with a code block — do NOT write a file
- If the user asks to *create* or *write* a file, write it to the project directory
- For scratch files you need temporarily, write to {SESSION_TMP}/ and clean up when done

{TOOL_CATALOG}`;

export class ContextManager {
  private history: Message[] = [];
  private skillContent: string[] = []; // activated skill bodies, never pruned
  private maxHistoryMessages = 50;
  private sessionTmpDir: string | undefined = undefined;
  private cachedSystemInstruction: string | null = null;
  private cachedToolSignature: string | null = null;

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
    this.cachedSystemInstruction = SYSTEM_INSTRUCTION.replace("{CWD}", process.cwd())
      .replace("{SESSION_TMP}", tmpDir)
      .replace("{TOOL_CATALOG}", toolCatalog);
    this.cachedToolSignature = signature;
    return this.cachedSystemInstruction;
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
