import { describe, it, expect } from "vitest";
import { mkdir, writeFile, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "../core/agent.js";
import { ToolRegistry } from "../tools/registry.js";
import { SkillRegistry } from "./registry.js";
import type { LLMClient } from "../providers/client.js";
import type { StreamEvent, Message } from "../providers/types.js";

type AnyEvent = { type: string; [k: string]: unknown };

describe("Skill injection visible to next LLM turn (E2E)", () => {
  it("injects activated skill body into the messages array seen by the next LLM call", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencli-skill-e2e-"));
    try {
      // Create a real SKILL.md on disk so SkillRegistry.discover() picks it up
      const skillDir = join(root, ".opencli", "skills", "test-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        `---
name: test-skill
description: A minimal test skill for E2E verification.
---
SKILL_BODY_SENTINEL: do the test-skill thing`,
        "utf8",
      );

      const skills = new SkillRegistry();
      await skills.discover(root);
      expect(skills.has("test-skill")).toBe(true);

      let callCount = 0;
      let secondCallMessages: Message[] = [];

      const client: LLMClient = {
        async *stream(messages, _sys, _tools): AsyncGenerator<StreamEvent> {
          callCount++;
          if (callCount === 1) {
            // Turn 1: activate the skill
            yield {
              type: "function_call",
              id: "call-skill",
              name: "activate_skill",
              args: { name: "test-skill" },
            };
            yield { type: "done" };
          } else {
            // Turn 2: capture messages for assertion, then finish
            secondCallMessages = messages;
            yield { type: "text", text: "Used the skill." };
            yield { type: "done" };
          }
        },
      };

      const agent = new Agent(client, new ToolRegistry(), skills);
      const events: AnyEvent[] = [];
      for await (const e of agent.run("activate the skill")) {
        events.push(e as AnyEvent);
      }

      // skill_activated event emitted
      const skillEvent = events.find((e) => e.type === "skill_activated");
      expect(skillEvent?.name).toBe("test-skill");

      // On the second LLM call, messages must contain the skill body text
      expect(callCount).toBe(2);
      const allText = JSON.stringify(secondCallMessages);
      expect(allText).toContain("test-skill");
      expect(allText).toContain("SKILL_BODY_SENTINEL");
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it("does not re-inject a skill that is already active in context", async () => {
    const root = await mkdtemp(join(tmpdir(), "opencli-skill-e2e-"));
    try {
      const skillDir = join(root, ".opencli", "skills", "dup-skill");
      await mkdir(skillDir, { recursive: true });
      await writeFile(
        join(skillDir, "SKILL.md"),
        `---
name: dup-skill
description: Skill used to verify deduplication.
---
DUP_SKILL_BODY`,
        "utf8",
      );

      const skills = new SkillRegistry();
      await skills.discover(root);

      const loadedBodies: string[] = [];
      const originalLoad = skills.load.bind(skills);
      skills.load = async (name: string, args?: string) => {
        const body = await originalLoad(name, args);
        if (body) loadedBodies.push(body);
        return body;
      };

      let callCount = 0;
      const client: LLMClient = {
        async *stream(_messages, _sys, _tools): AsyncGenerator<StreamEvent> {
          callCount++;
          if (callCount === 1) {
            // Activate the same skill twice in one batch
            yield {
              type: "function_call",
              id: "c1",
              name: "activate_skill",
              args: { name: "dup-skill" },
            };
            yield {
              type: "function_call",
              id: "c2",
              name: "activate_skill",
              args: { name: "dup-skill" },
            };
            yield { type: "done" };
          } else {
            yield { type: "text", text: "Done." };
            yield { type: "done" };
          }
        },
      };

      const agent = new Agent(client, new ToolRegistry(), skills);
      for await (const _e of agent.run("activate dup")) {
        void _e;
      }

      // skill body should have been loaded exactly once despite two activate_skill calls
      expect(loadedBodies).toHaveLength(1);
    } finally {
      await rm(root, { recursive: true });
    }
  });
});
