import { readFile } from "node:fs/promises";
import { execSync } from "node:child_process";
import { parse as parseYaml } from "yaml";

export interface SkillMeta {
  name: string;
  description: string;
  allowedTools?: string[];
  disableAgentInvocation?: boolean;
  body: string; // raw SKILL.md body (frontmatter stripped)
}

// Parse a SKILL.md file into metadata + raw body
export async function loadSkillFile(filePath: string): Promise<SkillMeta> {
  const raw = await readFile(filePath, "utf8");
  const { frontmatter, body } = splitFrontmatter(raw);

  const fm = frontmatter ? (parseYaml(frontmatter) as Record<string, unknown>) : {};

  const name = (fm.name as string | undefined) ?? inferNameFromPath(filePath);
  const description = fm.description as string | undefined;

  if (!name) throw new Error(`Skill at ${filePath} is missing a name`);
  if (!description) throw new Error(`Skill "${name}" is missing a description`);

  return {
    name,
    description,
    allowedTools: fm["allowed-tools"] ? (fm["allowed-tools"] as string).split(/\s+/) : undefined,
    disableAgentInvocation: Boolean(fm["disable-agent-invocation"]),
    body,
  };
}

// Apply shell preprocessing (!{cmd}) and argument substitution ($ARGUMENTS / $0, $1, ...)
export function processBody(body: string, args = ""): string {
  const argList = args.trim().split(/\s+/).filter(Boolean);

  // Run !{cmd} shell preprocessors
  let result = body.replace(/!\{([^}]+)\}/g, (_match, cmd: string) => {
    try {
      return execSync(cmd.trim(), { encoding: "utf8", timeout: 5000 }).trimEnd();
    } catch {
      return `(error running: ${cmd.trim()})`;
    }
  });

  // Substitute positional args $0, $1, ...
  for (let i = 0; i < argList.length; i++) {
    result = result.replaceAll(`$${i}`, argList[i]);
  }

  // Substitute $ARGUMENTS with the full args string
  result = result.replaceAll("$ARGUMENTS", args);

  return result;
}

function splitFrontmatter(content: string): { frontmatter: string | null; body: string } {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return { frontmatter: null, body: content };
  return { frontmatter: match[1], body: match[2] };
}

function inferNameFromPath(filePath: string): string {
  // .../skills/review/SKILL.md → "review"
  const parts = filePath.replace(/\\/g, "/").split("/");
  const skillIdx = parts.lastIndexOf("SKILL.md");
  return skillIdx > 0 ? parts[skillIdx - 1] : "";
}
