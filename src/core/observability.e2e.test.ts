import { describe, it, expect } from "vitest";
import { writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "./agent.js";
import { createDefaultRegistry } from "../tools/index.js";
import { SkillRegistry } from "../skills/registry.js";
import type { LLMClient } from "../providers/client.js";
import type { StreamEvent } from "../providers/types.js";
import type { ObservabilityEvent } from "./observability.js";

describe("Observability full event sequence (E2E)", () => {
  it("emits events in correct order across a two-turn agent run with a real tool call", async () => {
    const dir = await mkdtemp(join(tmpdir(), "opencli-obs-e2e-"));
    try {
      const filePath = join(dir, "data.txt");
      await writeFile(filePath, "obs-test-content", "utf8");

      let callCount = 0;
      const client: LLMClient = {
        async *stream(_messages, _sys, _tools): AsyncGenerator<StreamEvent> {
          callCount++;
          if (callCount === 1) {
            yield {
              type: "function_call",
              id: "call-read",
              name: "read",
              args: { file_path: filePath },
            };
            yield { type: "done" };
          } else {
            yield { type: "usage", inputTokens: 10, outputTokens: 5 };
            yield { type: "text", text: "Done." };
            yield { type: "done" };
          }
        },
      };

      const obsEvents: ObservabilityEvent[] = [];
      const agent = new Agent(
        client,
        createDefaultRegistry(),
        new SkillRegistry(),
        undefined,
        undefined,
        50,
        { model: "test-model", onObservability: (e) => obsEvents.push(e) },
      );

      for await (const _e of agent.run("read the file")) {
        void _e;
      }

      const types = obsEvents.map((e) => e.type);

      // Turn 1: context_snapshot → llm_call_start → llm_call_end → tool_exec_start → tool_exec_end
      expect(types[0]).toBe("context_snapshot");
      expect(types[1]).toBe("llm_call_start");
      expect(types[2]).toBe("llm_call_end");
      expect(types[3]).toBe("tool_exec_start");
      expect(types[4]).toBe("tool_exec_end");

      // Turn 2: context_snapshot → llm_call_start → llm_call_end
      expect(types[5]).toBe("context_snapshot");
      expect(types[6]).toBe("llm_call_start");
      expect(types[7]).toBe("llm_call_end");

      expect(types).toHaveLength(8);

      // Spot-check metadata on the tool events
      const execStart = obsEvents.find((e) => e.type === "tool_exec_start") as Extract<
        ObservabilityEvent,
        { type: "tool_exec_start" }
      >;
      expect(execStart.name).toBe("read");
      expect(execStart.args).toMatchObject({ file_path: filePath });

      const execEnd = obsEvents.find((e) => e.type === "tool_exec_end") as Extract<
        ObservabilityEvent,
        { type: "tool_exec_end" }
      >;
      expect(execEnd.name).toBe("read");
      expect(execEnd.success).toBe(true);
      expect(execEnd.latencyMs).toBeGreaterThanOrEqual(0);
      expect(execEnd.outputBytes).toBeGreaterThan(0);

      // Second llm_call_end should carry token counts from the usage event
      const llmEnds = obsEvents.filter((e) => e.type === "llm_call_end") as Extract<
        ObservabilityEvent,
        { type: "llm_call_end" }
      >[];
      expect(llmEnds).toHaveLength(2);
      expect(llmEnds[1].inputTokens).toBe(10);
      expect(llmEnds[1].outputTokens).toBe(5);
    } finally {
      await rm(dir, { recursive: true });
    }
  });

  it("emits context_snapshot with growing messageCount across turns", async () => {
    let callCount = 0;
    const client: LLMClient = {
      async *stream(_messages, _sys, _tools): AsyncGenerator<StreamEvent> {
        callCount++;
        if (callCount === 1) {
          yield { type: "function_call", id: "c1", name: "noop", args: {} };
          yield { type: "done" };
        } else {
          yield { type: "text", text: "done" };
          yield { type: "done" };
        }
      },
    };

    const registry = createDefaultRegistry();
    // Register a cheap noop so the tool call succeeds without I/O
    registry.register({
      name: "noop",
      description: "",
      parameters: { type: "object", properties: {} },
      execute: async () => ({ success: true, output: "noop result" }),
    });

    const obsEvents: ObservabilityEvent[] = [];
    const agent = new Agent(client, registry, new SkillRegistry(), undefined, undefined, 50, {
      onObservability: (e) => obsEvents.push(e),
    });

    for await (const _e of agent.run("go")) {
      void _e;
    }

    const snapshots = obsEvents.filter((e) => e.type === "context_snapshot") as Extract<
      ObservabilityEvent,
      { type: "context_snapshot" }
    >[];
    expect(snapshots).toHaveLength(2);
    // Each turn adds messages, so the count must be non-decreasing
    expect(snapshots[1].messageCount).toBeGreaterThan(snapshots[0].messageCount);
  });
});
