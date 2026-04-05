import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SkillRegistry } from "./registry.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = join(tmpdir(), `gemini-skill-reg-test-${Date.now()}`);
  await mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function createSkill(baseDir: string, name: string, description: string, body = "Instructions for $ARGUMENTS"): Promise<void> {
  const skillDir = join(baseDir, name);
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`,
  );
}

describe("SkillRegistry", () => {
  it("discovers skills from a project directory", async () => {
    const projectDir = join(tmpDir, "project");
    const skillsDir = join(projectDir, ".gemini-agent", "skills");
    await mkdir(skillsDir, { recursive: true });
    await createSkill(skillsDir, "review", "Review code for issues.");

    const registry = new SkillRegistry();
    await registry.discover(projectDir);

    expect(registry.has("review")).toBe(true);
    expect(registry.get("review")?.description).toBe("Review code for issues.");
  });

  it("lists all discovered skills", async () => {
    const projectDir = join(tmpDir, "project");
    const skillsDir = join(projectDir, ".gemini-agent", "skills");
    await mkdir(skillsDir, { recursive: true });
    await createSkill(skillsDir, "review", "Review code.");
    await createSkill(skillsDir, "explain", "Explain code.");

    const registry = new SkillRegistry();
    await registry.discover(projectDir);

    const names = registry.list().map((s) => s.name);
    expect(names).toContain("review");
    expect(names).toContain("explain");
  });

  it("project skills take precedence over user-global skills", async () => {
    // We can only test the cross-client .agents/skills/ path here to avoid touching real ~/.gemini-agent
    const projectDir = join(tmpDir, "project");
    const projectSkillsDir = join(projectDir, ".gemini-agent", "skills");
    const agentsSkillsDir = join(projectDir, ".agents", "skills");
    await mkdir(projectSkillsDir, { recursive: true });
    await mkdir(agentsSkillsDir, { recursive: true });

    await createSkill(projectSkillsDir, "review", "Project review");
    await createSkill(agentsSkillsDir, "review", "Cross-client review");

    const registry = new SkillRegistry();
    await registry.discover(projectDir);

    // project-scoped should win
    expect(registry.get("review")?.description).toBe("Project review");
  });

  it("gracefully skips non-existent directories", async () => {
    const registry = new SkillRegistry();
    await expect(registry.discover(join(tmpDir, "nonexistent"))).resolves.not.toThrow();
  });

  it("loads and processes skill body with $ARGUMENTS", async () => {
    const projectDir = join(tmpDir, "project");
    const skillsDir = join(projectDir, ".gemini-agent", "skills");
    await mkdir(skillsDir, { recursive: true });
    await createSkill(skillsDir, "review", "Review code.", "Review $ARGUMENTS for issues.");

    const registry = new SkillRegistry();
    await registry.discover(projectDir);

    const body = await registry.load("review", "src/auth.ts");
    expect(body?.trim()).toBe("Review src/auth.ts for issues.");
  });

  it("returns undefined for unknown skill", async () => {
    const registry = new SkillRegistry();
    const body = await registry.load("nonexistent");
    expect(body).toBeUndefined();
  });

  it("generates a catalog summary", async () => {
    const projectDir = join(tmpDir, "project");
    const skillsDir = join(projectDir, ".gemini-agent", "skills");
    await mkdir(skillsDir, { recursive: true });
    await createSkill(skillsDir, "review", "Review code for issues.");

    const registry = new SkillRegistry();
    await registry.discover(projectDir);

    const summary = registry.catalogSummary();
    expect(summary).toContain("review");
    expect(summary).toContain("Review code for issues.");
  });

  it("returns empty string catalog summary when no skills", () => {
    const registry = new SkillRegistry();
    expect(registry.catalogSummary()).toBe("");
  });
});
