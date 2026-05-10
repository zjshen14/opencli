import { execFileSync } from "node:child_process";
import { writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "../core/agent.js";
import type { Session } from "../state/session.js";
import { selectKey } from "./input.js";
import { printError, printInfo } from "./renderer.js";
import { runAgentTurn } from "./runner.js";

export async function runPlanFlow(
  agent: Agent,
  session: Session,
  planPrompt: string,
): Promise<void> {
  const planText = await runAgentTurn(agent, session, planPrompt, "plan");
  if (!planText.trim()) return;

  const decision = await promptPlanApproval();
  if (decision === "cancel") {
    printInfo("Plan cancelled.");
    return;
  }
  let finalPlan = planText;
  if (decision === "edit") {
    const edited = await editPlanInEditor(planText);
    if (!edited) {
      printInfo("Edit cancelled.");
      return;
    }
    finalPlan = edited;
  }
  printInfo("\nExecuting approved plan…\n");
  await runAgentTurn(
    agent,
    session,
    `I have approved the following plan. Execute it step by step, checking off each item as you complete it:\n\n${finalPlan}`,
    "react",
  );
}

async function promptPlanApproval(): Promise<"approve" | "edit" | "cancel"> {
  const choice = await selectKey("Plan ready — what next?", [
    { key: "a", label: "Approve & execute" },
    { key: "e", label: "Edit in $EDITOR first" },
    { key: "c", label: "Cancel" },
  ]);
  if (choice === "a") return "approve";
  if (choice === "e") return "edit";
  return "cancel";
}

async function editPlanInEditor(plan: string): Promise<string | null> {
  const tmpPath = join(tmpdir(), `opencli-plan-${Date.now()}.md`);
  await writeFile(tmpPath, plan);
  const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
  try {
    execFileSync(editor, [tmpPath], { stdio: "inherit" });
    const edited = await readFile(tmpPath, "utf8");
    return edited.trim() || null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    printError(`Failed to open editor (${editor}): ${message}`);
    return null;
  } finally {
    await rm(tmpPath).catch(() => {});
  }
}
