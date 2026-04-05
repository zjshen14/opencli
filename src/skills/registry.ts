import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { loadSkillFile, type SkillMeta } from "./loader.js";

// Skill discovery paths in priority order (first wins on name conflict)
function getSkillDirs(projectRoot: string): string[] {
  const builtinDir = join(fileURLToPath(import.meta.url), "../../skills/builtin");
  return [
    join(projectRoot, ".gemini-agent", "skills"), // project-scoped
    join(projectRoot, ".agents", "skills"), // cross-client standard
    join(homedir(), ".gemini-agent", "skills"), // user-global
    resolve(builtinDir), // bundled built-ins
  ];
}

export interface SkillEntry extends SkillMeta {
  dir: string; // directory containing SKILL.md
}

export class SkillRegistry {
  private catalog = new Map<string, SkillEntry>();

  async discover(projectRoot = process.cwd()): Promise<void> {
    const dirs = getSkillDirs(projectRoot);

    for (const dir of dirs) {
      let entries: string[];
      try {
        entries = await readdir(dir);
      } catch {
        continue; // directory doesn't exist — fine
      }

      for (const name of entries) {
        if (this.catalog.has(name)) continue; // earlier dir takes precedence
        const skillDir = join(dir, name);
        const skillFile = join(skillDir, "SKILL.md");
        try {
          const meta = await loadSkillFile(skillFile);
          this.catalog.set(meta.name, { ...meta, dir: skillDir });
        } catch {
          // skip malformed skills
        }
      }
    }
  }

  list(): SkillEntry[] {
    return Array.from(this.catalog.values());
  }

  get(name: string): SkillEntry | undefined {
    return this.catalog.get(name);
  }

  has(name: string): boolean {
    return this.catalog.has(name);
  }

  // Load and return the processed skill body (shell preprocessing + arg substitution done by loader)
  async load(name: string, args = ""): Promise<string | undefined> {
    const entry = this.catalog.get(name);
    if (!entry) return undefined;
    const { processBody } = await import("./loader.js");
    return processBody(entry.body, args);
  }

  // Catalog description for injection into the system prompt
  catalogSummary(): string {
    const entries = this.list();
    if (entries.length === 0) return "";
    const lines = entries.map((s) => `- ${s.name}: ${s.description}`);
    return `## Available Skills\nActivate with /skill-name or by calling activate_skill.\n${lines.join("\n")}`;
  }
}
