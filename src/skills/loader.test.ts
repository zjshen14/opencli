import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadSkillFile, processBody } from "./loader.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `gemini-skill-test-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function writeSkill(name: string, content: string): Promise<string> {
  const dir = join(tmpDir, name);
  await mkdir(dir, { recursive: true });
  const path = join(dir, "SKILL.md");
  await writeFile(path, content);
  return path;
}

describe("loadSkillFile", () => {
  it("parses name and description from frontmatter", async () => {
    const path = await writeSkill(
      "review",
      `---\nname: review\ndescription: Review code for issues.\n---\n\nInstructions here.`,
    );
    const meta = await loadSkillFile(path);
    expect(meta.name).toBe("review");
    expect(meta.description).toBe("Review code for issues.");
  });

  it("parses allowed-tools as an array", async () => {
    const path = await writeSkill(
      "test",
      `---\nname: test\ndescription: Write tests.\nallowed-tools: Read Bash Grep\n---\n\nInstructions.`,
    );
    const meta = await loadSkillFile(path);
    expect(meta.allowedTools).toEqual(["Read", "Bash", "Grep"]);
  });

  it("parses disable-agent-invocation", async () => {
    const path = await writeSkill(
      "commit",
      `---\nname: commit\ndescription: Commit changes.\ndisable-agent-invocation: true\n---\n\nInstructions.`,
    );
    const meta = await loadSkillFile(path);
    expect(meta.disableAgentInvocation).toBe(true);
  });

  it("strips frontmatter from body", async () => {
    const path = await writeSkill(
      "explain",
      `---\nname: explain\ndescription: Explain code.\n---\n\nExplain this: $ARGUMENTS`,
    );
    const meta = await loadSkillFile(path);
    expect(meta.body).toContain("Explain this: $ARGUMENTS");
    expect(meta.body).not.toContain("name: explain");
  });

  it("uses directory name when name is missing from frontmatter", async () => {
    const path = await writeSkill(
      "inferred",
      `---\ndescription: No explicit name.\n---\n\nContent.`,
    );
    const meta = await loadSkillFile(path);
    expect(meta.name).toBe("inferred");
  });

  it("throws when description is missing", async () => {
    const path = await writeSkill("bad2", `---\nname: bad2\n---\n\nContent.`);
    await expect(loadSkillFile(path)).rejects.toThrow(/missing a description/);
  });

  it("handles skill with no frontmatter (infers name from path)", async () => {
    const dir = join(tmpDir, "nofm");
    await mkdir(dir, { recursive: true });
    const path = join(dir, "SKILL.md");
    await writeFile(path, "Just instructions, no frontmatter.");
    await expect(loadSkillFile(path)).rejects.toThrow(); // missing description
  });
});

describe("processBody", () => {
  it("substitutes $ARGUMENTS", () => {
    const result = processBody("Review $ARGUMENTS for issues.", "src/auth.ts");
    expect(result).toBe("Review src/auth.ts for issues.");
  });

  it("substitutes positional args $0, $1", () => {
    const result = processBody("Migrate $0 from $1 to $2", "Button React Vue");
    expect(result).toBe("Migrate Button from React to Vue");
  });

  it("leaves $ARGUMENTS empty string when no args", () => {
    const result = processBody("Instructions: $ARGUMENTS");
    expect(result).toBe("Instructions: ");
  });

  it("runs !{cmd} shell preprocessing", () => {
    const result = processBody("Node version: !{node --version}");
    expect(result).toMatch(/Node version: v\d+/);
  });

  it("handles failed !{cmd} gracefully", () => {
    const result = processBody("Output: !{this-command-does-not-exist-xyz}");
    expect(result).toContain("error running");
  });

  it("does not mutate parts of body without substitution markers", () => {
    const body = "No substitution markers here.";
    expect(processBody(body, "anything")).toBe(body);
  });
});
