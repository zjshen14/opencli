import type { AgentEvent } from "../core/agent.js";

/** Stable public schema for each NDJSON line emitted by --output=json. */
export type JsonOutputEvent =
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: string }
  | { type: "skill_activated"; name: string }
  | { type: "error"; message: string }
  | { type: "notice"; message: string }
  | { type: "done" };

/**
 * Converts an AgentEvent to a newline-terminated JSON line for --output=json.
 * Returns null for events with no public representation (forward-compat guard).
 * Strips thoughtSignature from tool_call — it is a provider-internal Gemini field.
 */
export function toJsonLine(event: AgentEvent): string | null {
  let out: JsonOutputEvent;
  switch (event.type) {
    case "text":
      out = { type: "text", text: event.text };
      break;
    case "tool_call":
      out = { type: "tool_call", name: event.name, args: event.args };
      break;
    case "tool_result":
      out = { type: "tool_result", name: event.name, result: event.result };
      break;
    case "skill_activated":
      out = { type: "skill_activated", name: event.name };
      break;
    case "error":
      out = { type: "error", message: event.message };
      break;
    case "notice":
      out = { type: "notice", message: event.message };
      break;
    case "done":
      out = { type: "done" };
      break;
    default:
      return null;
  }
  return JSON.stringify(out) + "\n";
}
