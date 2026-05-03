import { describe, it, expect } from "vitest";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "./agent.js";
import { createDefaultRegistry } from "../tools/index.js";
import { SkillRegistry } from "../skills/registry.js";
import type { LLMClient } from "../providers/client.js";
import type { StreamEvent, Message } from "../providers/types.js";

type AnyEvent = { type: string; [k: string]: unknown };

describe("Agent + real file tool round-trip (E2E)", () => {
  it("reads a temp file via the read tool and delivers result to the next LLM turn", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencli-e2e-"));
    try {
      const filePath = join(dir, "hello.txt");
      const fileContent = "Hello from the real filesystem!";
      await writeFile(filePath, fileContent, "utf8");

      let callCount = 0;
      let secondCallMessages: Message[] = [];

      const client: LLMClient = {
        async *stream(messages, _sys, _tools): AsyncGenerator<StreamEvent> {
          callCount++;
          if (callCount === 1) {
            // Turn 1: request a read of the temp file
            yield {
              type: "function_call",
              id: "call-read",
              name: "read",
              args: { file_path: filePath },
            };
            yield { type: "done" };
          } else {
            // Turn 2: capture messages and produce final text
            secondCallMessages = messages;
            yield { type: "text", text: `Content: ${fileContent}` };
            yield { type: "done" };
          }
        },
      };

      const agent = new Agent(client, createDefaultRegistry(), new SkillRegistry());
      const events: AnyEvent[] = [];
      for await (const e of agent.run("read the file")) {
        events.push(e as AnyEvent);
      }

      // tool_call event was yielded for "read"
      const toolCall = events.find((e) => e.type === "tool_call");
      expect(toolCall?.name).toBe("read");

      // tool_result contains the actual file content
      const toolResult = events.find((e) => e.type === "tool_result");
      expect(toolResult?.result).toContain(fileContent);

      // Second LLM call received a function_result message (real serialization round-trip)
      expect(callCount).toBe(2);
      const hasResult = secondCallMessages.some((m) =>
        m.parts.some((p) => p.type === "function_result"),
      );
      expect(hasResult).toBe(true);

      // Final text and done events
      expect(events.find((e) => e.type === "text")).toBeDefined();
      expect(events.find((e) => e.type === "done")).toBeDefined();
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("executes a bash tool call and surfaces its stdout in the next LLM turn", async () => {
    let callCount = 0;
    let secondCallMessages: Message[] = [];

    const client: LLMClient = {
      async *stream(messages, _sys, _tools): AsyncGenerator<StreamEvent> {
        callCount++;
        if (callCount === 1) {
          yield {
            type: "function_call",
            id: "call-bash",
            name: "bash",
            args: { command: "echo opencli-e2e-marker" },
          };
          yield { type: "done" };
        } else {
          secondCallMessages = messages;
          yield { type: "text", text: "Ran bash." };
          yield { type: "done" };
        }
      },
    };

    // Auto-approve the bash confirmation gate
    const agent = new Agent(client, createDefaultRegistry(), new SkillRegistry());
    agent.setConfirmFn(async () => "allow");

    const events: AnyEvent[] = [];
    for await (const e of agent.run("run echo")) {
      events.push(e as AnyEvent);
    }

    const toolResult = events.find((e) => e.type === "tool_result");
    expect(toolResult?.result).toContain("opencli-e2e-marker");

    expect(callCount).toBe(2);
    const hasResult = secondCallMessages.some((m) =>
      m.parts.some((p) => p.type === "function_result"),
    );
    expect(hasResult).toBe(true);
  });
});
