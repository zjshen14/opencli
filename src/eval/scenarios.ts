import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

export interface FileExpectation {
  contains?: string | string[];
  notContains?: string;
  exists?: boolean;
}

export interface ScenarioExpected {
  outputKeywords?: string[];
  files?: Record<string, FileExpectation>;
}

export interface Scenario {
  id: string;
  category: "read-explain" | "bug-fix" | "feature-add" | "refactor" | "multi-file";
  description: string;
  prompt: string;
  fixture: string;
  sandbox?: "auto";
  expected: ScenarioExpected;
}

export async function loadScenarios(): Promise<Scenario[]> {
  const dir = join(fileURLToPath(import.meta.url), "..", "scenarios");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".yaml")).sort();
  return Promise.all(
    files.map(async (f) => parse(await readFile(join(dir, f), "utf8")) as Scenario),
  );
}
