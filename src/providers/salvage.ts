/**
 * Tool-call salvage for OSS and local models.
 *
 * Many open-weight models advertise tool-calling support but do not reliably emit the
 * special tokens their chat template asks for. Verified against `qwen2.5-coder:14b` on
 * Ollama 0.32.5: the template instructs the model to wrap calls in `<tool_call>` tags,
 * the model emits bare JSON instead, Ollama's parser finds no tags, and the payload ends
 * up in `message.content` with `finish_reason: "stop"` and `tool_calls: null`. This
 * reproduces identically on the native `/api/chat` and the OpenAI-compatible endpoint,
 * confirming it is a model instruction-following gap rather than a translation bug.
 *
 * The agentic loop then sees zero function calls and ends the turn, so local support
 * connects successfully and does nothing useful. Salvage recovers those calls.
 *
 * Safety: salvage only runs when a turn produced NO structured tool calls, and only
 * promotes a payload whose `name` matches a tool actually offered in that request. A
 * model merely *discussing* a tool in prose is never silently turned into an execution.
 */

export interface SalvagedCall {
  name: string;
  args: Record<string, unknown>;
}

/** Matches ```json ... ``` or ``` ... ``` fences, which models add despite instructions. */
const FENCE_RE = /^```(?:json)?\s*([\s\S]*?)\s*```$/;

/**
 * Extracts `<tool_call>...</tool_call>` bodies. Models often comply partially — emitting
 * the wrapper but with stray prose around it, which defeats Ollama's stricter parser.
 */
function extractTagged(content: string): string[] {
  const bodies: string[] = [];
  const re = /<tool_call>([\s\S]*?)<\/tool_call>/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    bodies.push(match[1].trim());
  }
  return bodies;
}

/** Strips a surrounding code fence, if present. */
function stripFence(text: string): string {
  const match = FENCE_RE.exec(text.trim());
  return match ? match[1].trim() : text.trim();
}

/**
 * Coerces one parsed JSON value into a call. Accepts both the template-documented
 * `{name, arguments}` shape and the OpenAI-style `{function: {name, arguments}}` some
 * models imitate. `arguments` may arrive as an object or as a JSON-encoded string.
 */
function toCall(value: unknown): SalvagedCall | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const obj = value as Record<string, unknown>;

  const inner =
    typeof obj.function === "object" && obj.function !== null
      ? (obj.function as Record<string, unknown>)
      : obj;

  const name = inner.name;
  if (typeof name !== "string" || name.length === 0) return undefined;

  let rawArgs = inner.arguments ?? inner.parameters ?? inner.args;

  if (typeof rawArgs === "string") {
    try {
      rawArgs = JSON.parse(rawArgs);
    } catch {
      return undefined;
    }
  }

  // A call with no arguments is legitimate for zero-parameter tools.
  if (rawArgs === undefined || rawArgs === null) return { name, args: {} };
  if (typeof rawArgs !== "object" || Array.isArray(rawArgs)) return undefined;

  return { name, args: rawArgs as Record<string, unknown> };
}

/** Parses one candidate string into zero or more calls. */
function parseCandidate(text: string): SalvagedCall[] {
  const cleaned = stripFence(text);
  if (!cleaned.startsWith("{") && !cleaned.startsWith("[")) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }

  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values.map(toCall).filter((c): c is SalvagedCall => c !== undefined);
}

/**
 * Attempts to recover tool calls from assistant text content.
 *
 * @param content   Raw assistant text for the turn.
 * @param toolNames Names offered in this request. A payload naming anything else is
 *                  left as prose — this check is what makes salvage safe.
 */
export function salvageToolCalls(content: string, toolNames: readonly string[]): SalvagedCall[] {
  if (!content || toolNames.length === 0) return [];

  const offered = new Set(toolNames);

  // Prefer explicitly tagged bodies; fall back to treating the whole content as JSON.
  const tagged = extractTagged(content);
  const candidates = tagged.length > 0 ? tagged : [content];

  const calls: SalvagedCall[] = [];
  for (const candidate of candidates) {
    for (const call of parseCandidate(candidate)) {
      if (offered.has(call.name)) calls.push(call);
    }
  }
  return calls;
}

/**
 * True when the content is *entirely* a salvaged payload, meaning it should be suppressed
 * from display rather than shown to the user as stray JSON. When a model mixes prose with
 * a tool call we keep the prose visible.
 */
export function contentIsOnlyToolCalls(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0) return false;

  const withoutTags = trimmed.replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "").trim();
  if (withoutTags.length === 0) return true;

  const cleaned = stripFence(trimmed);
  if (!cleaned.startsWith("{") && !cleaned.startsWith("[")) return false;
  try {
    JSON.parse(cleaned);
    return true;
  } catch {
    return false;
  }
}
