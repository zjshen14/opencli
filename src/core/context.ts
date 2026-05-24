import type { Message, ToolDefinition } from "../providers/types.js";
import { DEFAULT_SYSTEM_INSTRUCTION, getGitContext, renderSystemInstruction } from "./prompt.js";

export class ContextManager {
  private history: Message[] = [];
  private skillContent: string[] = []; // activated skill bodies, never pruned
  private activatedSkills = new Set<string>();
  private maxHistoryMessages: number;
  private sessionTmpDir: string | undefined = undefined;
  private cachedSystemInstruction: string | null = null;
  private cachedToolSignature: string | null = null;
  private skillCatalog = "";

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

  setSkillCatalog(catalog: string): void {
    this.skillCatalog = catalog;
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

    const rendered = renderSystemInstruction(this.systemInstructionTemplate, {
      cwd: process.cwd(),
      tmpDir: this.sessionTmpDir ?? `${process.cwd()}/.opencli/tmp`,
      tools,
      gitContext: getGitContext(),
      skillCatalog: this.skillCatalog,
    });
    this.cachedSystemInstruction = rendered;
    this.cachedToolSignature = signature;
    return rendered;
  }

  addMessage(message: Message): void {
    // Merge into the previous message when both are text-only `user` turns.
    // This happens after restoring a session that ended on a user message (e.g.
    // the agent crashed mid-turn, or a REPL-only slash command was logged):
    // the user types again, producing two consecutive `user` messages, which
    // providers reject with INVALID_ARGUMENT (role alternation violation).
    // Carrying-`function_result` user messages are NOT merged — they pair with
    // a prior tool call and must stay distinct.
    const last = this.history[this.history.length - 1];
    if (last && isUserTextOnly(last) && isUserTextOnly(message)) {
      const mergedText =
        last.parts.map((p) => (p as { type: "text"; text: string }).text).join("\n\n") +
        "\n\n" +
        message.parts.map((p) => (p as { type: "text"; text: string }).text).join("\n\n");
      this.history[this.history.length - 1] = {
        role: "user",
        parts: [{ type: "text", text: mergedText }],
      };
    } else {
      this.history.push(message);
    }
    this.prune();
  }

  addSkillContent(name: string, body: string): void {
    this.activatedSkills.add(name);
    const tagged = `<skill_content name="${name}">\n${body}\n</skill_content>`;
    this.skillContent.push(tagged);
  }

  hasSkill(name: string): boolean {
    return this.activatedSkills.has(name);
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

  get messageCount(): number {
    return this.history.length;
  }

  get maxMessages(): number {
    return this.maxHistoryMessages;
  }

  clear(): void {
    this.history = [];
    this.skillContent = [];
    this.activatedSkills.clear();
    this.cachedSystemInstruction = null;
    this.cachedToolSignature = null;
  }

  private prune(): void {
    if (this.history.length <= this.maxHistoryMessages) return;

    // Reserve a slot to preserve the very first user text message — typically
    // the original task that anchors the whole session. Without this, prune
    // silently drops the goal once history exceeds the window, regardless of
    // whether the session is resumed or grew organically. A5b's planned
    // auto-compact will replace this with a real LLM summary; this is the
    // cheap interim that prevents the agent saying "I have no context".
    const first = this.history[0];
    const anchor =
      this.maxHistoryMessages > 1 &&
      first?.role === "user" &&
      first.parts.length > 0 &&
      first.parts.every((p) => p.type === "text")
        ? first
        : null;

    const windowSize = this.maxHistoryMessages - (anchor ? 1 : 0);
    const sliced = this.history.slice(-windowSize);

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

    let pruned: Message[];
    if (startIdx < sliced.length) {
      pruned = sliced.slice(startIdx);
    } else {
      // No clean user message found from the head — scan from the tail so we
      // don't return a model-first window (providers reject with INVALID_ARGUMENT).
      // This happens when a single user turn triggers so many tool-call/result
      // pairs that the original user message scrolls out of the window.
      let tailIdx = sliced.length - 1;
      while (tailIdx >= 0) {
        const msg = sliced[tailIdx];
        if (msg.role === "user" && !msg.parts.some((p) => p.type === "function_result")) {
          break;
        }
        tailIdx--;
      }

      if (tailIdx >= 0) {
        pruned = sliced.slice(tailIdx);
      } else {
        // Truly pathological: no clean user text message anywhere in the window
        // (e.g. maxHistoryMessages is so small the window is pure tool-call/result
        // pairs). Prepend a synthetic anchor so history never starts with a model
        // turn — providers require the first message to be a user text message.
        pruned = [
          {
            role: "user",
            parts: [{ type: "text", text: "(earlier context unavailable — history was pruned)" }],
          },
          ...sliced,
        ];
      }
    }

    // If anchor and pruned[0] are both text-only user messages, prepending the
    // anchor verbatim creates two consecutive `role: "user"` turns — providers
    // reject this with INVALID_ARGUMENT. Merge the texts so the boundary stays
    // a single user turn (separator marks the elided middle for the model).
    if (anchor && pruned.length > 0 && isUserTextOnly(pruned[0])) {
      const anchorText = anchor.parts
        .map((p) => (p as { type: "text"; text: string }).text)
        .join("\n\n");
      const headText = pruned[0].parts
        .map((p) => (p as { type: "text"; text: string }).text)
        .join("\n\n");
      const merged: Message = {
        role: "user",
        parts: [
          {
            type: "text",
            text: `${anchorText}\n\n[earlier conversation pruned]\n\n${headText}`,
          },
        ],
      };
      this.history = [merged, ...pruned.slice(1)];
    } else {
      this.history = anchor ? [anchor, ...pruned] : pruned;
    }
  }
}

function isUserTextOnly(msg: Message): boolean {
  return msg.role === "user" && msg.parts.length > 0 && msg.parts.every((p) => p.type === "text");
}
