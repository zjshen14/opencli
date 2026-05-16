# Design: A5 — /compact + /context

_Status: Ready for implementation. Tracking issue: [#26](https://github.com/zjshen14/opencli/issues/26). Phase: [Roadmap A5](../roadmap.md)._

---

## Problem and goal

`ContextManager.prune()` hard-drops old messages with `slice(-maxHistoryMessages)`. On long sessions the agent loses its original task description, early decisions, and file paths it already visited — causing drift and repeated work. Users have no way to see how full the context window is or to do anything about it before the drop happens silently.

**Goal:** give users a `/compact` command that replaces old messages with an LLM-generated summary, and a `/context` command that reports current context usage.

---

## Scope

| Item | V1 (this milestone) |
|---|---|
| `/compact` — manual LLM summarization | ✓ |
| `/context` — print message count + estimated tokens | ✓ |
| Auto-compact at 80% threshold | Deferred — add after manual `/compact` is validated in real sessions |
| Persistent token bar in REPL footer | Deferred to A6 (UX rendering milestone) |
| Separate cheap model for summarization | Deferred — use active session client; add `--compaction-model` when needed |

---

## Architecture

Compaction is a **core-layer** operation: it reads conversation history and makes one LLM call. It belongs in `src/core/`, not `src/cli/`.

`ContextManager` remains a **synchronous data store** — no async methods, no LLM dependency. A standalone `compactHistory()` function in `src/core/compact.ts` takes the context and client as arguments. This keeps the two concerns separately testable.

```
/compact (repl.ts)
  → agent.compact()              (agent.ts)
    → compactHistory(context, client)    (compact.ts)
        → context.getMessages()
        → client.stream(toSummarize, summarizationPrompt, [])  ← no tools
        → context.replaceHistory([summaryMsg, ...recentMsgs])
```

---

## New file: `src/core/compact.ts`

### Constants

```typescript
/** Messages to keep verbatim at the tail of history after compaction. */
const KEEP_RECENT = 10;

/** Don't compact if history is shorter than this — nothing useful to summarize. */
const COMPACT_MIN_MESSAGES = 4;

const SUMMARIZATION_PROMPT = `Summarize this coding session for context compaction.
Include: the original task, key decisions made, files created or modified (exact paths),
errors encountered and how they were resolved, and the current state of work.
Be concise — under 300 words. Preserve file paths, function names, and error messages exactly.
Do not narrate tool calls — focus on outcomes and current state.`;
```

### Interface

```typescript
export interface CompactResult {
  messagesRemoved: number;
  summaryLength: number;  // chars in the summary text
}

/**
 * Replace old messages in `context` with an LLM-generated summary.
 * Keeps the most recent KEEP_RECENT messages verbatim.
 * Returns { messagesRemoved: 0 } if history is too short to compact.
 * Never throws — surfaces errors via the returned result.
 */
export async function compactHistory(
  context: ContextManager,
  client: LLMClient,
): Promise<CompactResult>;
```

### Implementation

```typescript
export async function compactHistory(
  context: ContextManager,
  client: LLMClient,
): Promise<CompactResult> {
  const messages = context.getMessages();

  if (messages.length < COMPACT_MIN_MESSAGES) {
    return { messagesRemoved: 0, summaryLength: 0 };
  }

  const splitAt = Math.max(0, messages.length - KEEP_RECENT);
  const toSummarize = messages.slice(0, splitAt);
  const toKeep = messages.slice(splitAt);

  if (toSummarize.length === 0) {
    return { messagesRemoved: 0, summaryLength: 0 };
  }

  // Stream the summary — no tools, no function calls expected.
  let summary = "";
  for await (const event of client.stream(toSummarize, SUMMARIZATION_PROMPT, [])) {
    if (event.type === "text") summary += event.text;
  }

  const summaryMessage: Message = {
    role: "user",
    parts: [
      {
        type: "text",
        text: `[Session context compacted — earlier conversation summarized]\n\n${summary}`,
      },
    ],
  };

  context.replaceHistory([summaryMessage, ...toKeep]);
  return { messagesRemoved: toSummarize.length, summaryLength: summary.length };
}
```

**Why `client.stream()` with no tools, not a hypothetical `client.complete()`:**
`LLMClient` only exposes `stream()`. Adding `complete()` to the interface would require updating all three provider implementations for one use case. Collecting stream chunks in `compact.ts` achieves the same result without touching the provider interface.

**Why `role: "user"` for the summary message:**
Conversation history must begin with a user turn (provider requirement). A model turn at the head would be rejected. The `[Session context compacted]` prefix makes the synthetic nature of the message legible.

**Why `KEEP_RECENT = 10`:**
Keeps the last ~5 turns of back-and-forth (user message + model response = 2 messages per turn). Recent tool calls and their results — the agent's live work — are preserved verbatim. The summary covers everything older.

---

## Changes to `src/core/context.ts`

Three additions, no behaviour changes:

```typescript
// New public method — used by compactHistory() to install the compacted state.
// Does NOT call prune(): the caller has already sized the history correctly.
replaceHistory(messages: Message[]): void {
  this.history = messages;
}

// New getters — used by agent.getContextStats() for /context display.
get messageCount(): number {
  return this.history.length;
}

get maxMessages(): number {
  return this.maxHistoryMessages;
}
```

Estimated token count is computed in `agent.ts` (it already does this for observability) rather than in `ContextManager`, keeping the manager free of serialization concerns.

---

## Changes to `src/core/agent.ts`

```typescript
// New method — called by /compact in the REPL.
async compact(): Promise<CompactResult> {
  return compactHistory(this.context, this.client);
}

// New method — called by /context in the REPL.
getContextStats(): { messageCount: number; estimatedTokens: number; maxHistoryMessages: number } {
  const messages = this.context.getMessages();
  return {
    messageCount: this.context.messageCount,
    estimatedTokens: Math.round(JSON.stringify(messages).length / 4),
    maxHistoryMessages: this.context.maxMessages,
  };
}
```

---

## Changes to `src/cli/repl.ts`

### Add to `BUILTIN_COMMANDS`

```typescript
{ name: "compact", description: "summarize older conversation history to free context" },
{ name: "context", description: "show current context usage (messages + estimated tokens)" },
```

### `/compact` handler

```typescript
if (input === "/compact") {
  const stats = agent.getContextStats();
  if (stats.messageCount < 4) {
    printInfo("Nothing to compact — conversation is too short.");
    continue;
  }
  printInfo("Compacting conversation history…");
  const result = await agent.compact();
  if (result.messagesRemoved === 0) {
    printInfo("Nothing to compact — recent messages fill the full window.");
  } else {
    printInfo(
      `Compacted ${result.messagesRemoved} message(s) into a ${result.summaryLength}-char summary.`,
    );
  }
  continue;
}
```

### `/context` handler

```typescript
if (input === "/context") {
  const { messageCount, estimatedTokens, maxHistoryMessages } = agent.getContextStats();
  printInfo(`Messages:  ${messageCount} / ${maxHistoryMessages}`);
  printInfo(`Est. tokens: ~${estimatedTokens.toLocaleString()}`);
  continue;
}
```

---

## Failure modes

| Failure | Behaviour |
|---|---|
| History too short (< 4 messages) | Returns `{ messagesRemoved: 0 }`; REPL prints "too short" message |
| All messages fit in KEEP_RECENT window | Returns `{ messagesRemoved: 0 }`; REPL prints "fills the full window" |
| LLM call fails (network, API error) | `compact()` propagates the error; REPL catches and prints via `printError()`; history untouched |
| LLM returns empty summary | Summary message is `[Session context compacted]\n\n` — visibly empty; history still replaced; REPL prints compaction stats |
| `/compact` called during plan mode | Plan mode runs in `runPlanFlow()`, not the main REPL loop — this handler is unreachable from plan mode |

---

## Deferred: auto-compact

The issue proposes auto-compaction at 80% of `maxHistoryMessages`. This is deferred because:

1. It fires silently mid-session (users are surprised by the extra LLM call and cost)
2. It adds latency to `addMessage()` (currently synchronous and fast)
3. The right threshold and KEEP_RECENT values need real-session data to tune

Once `/compact` is validated in real sessions, auto-compact becomes a small addition: check `context.messageCount >= 0.8 * context.maxMessages` in the agent loop after `executeCalls()` and call `compactHistory()` automatically. Gate behind `config.autoCompact: boolean` (default `false`).

## Deferred: persistent footer

The roadmap mentions a "token bar in REPL footer." A persistent footer requires redrawing a status line on every input change — significant ANSI cursor management in `input.ts`. This is squarely in A6 (UX rendering milestone) scope. `/context` on demand covers the information need for A5.

---

## Test strategy

### `src/core/compact.test.ts` (new)

| Test | What it proves |
|---|---|
| History < 4 messages → `messagesRemoved: 0`, history unchanged | Short-session guard |
| All messages in KEEP_RECENT window → `messagesRemoved: 0` | Full-window guard |
| 20 messages → summary message + last 10 kept verbatim | Core compaction |
| Summary message has `role: "user"` and `[Session context compacted]` prefix | Message format |
| `messagesRemoved` = total − KEEP_RECENT | Count accuracy |
| Mock client returns empty string → summary message has empty body | Empty summary |

Use a mock `LLMClient` that returns a fixed summary string synchronously. No real API calls.

### `src/core/context.test.ts` (extend)

| Test | What it proves |
|---|---|
| `replaceHistory([])` → `messageCount === 0` | Replace with empty |
| `replaceHistory(msgs)` → `messageCount === msgs.length` | Replace with content |
| `maxMessages` returns constructor value | Getter correct |
| `messageCount` tracks `addMessage` calls | Getter correct |

---

## File change summary

| Action | File |
|---|---|
| Create | `src/core/compact.ts` |
| Create | `src/core/compact.test.ts` |
| Modify | `src/core/context.ts` — add `replaceHistory()`, `messageCount` getter, `maxMessages` getter |
| Modify | `src/core/context.test.ts` — extend with new method tests |
| Modify | `src/core/agent.ts` — add `compact()`, `getContextStats()` |
| Modify | `src/cli/repl.ts` — add `/compact` and `/context` to `BUILTIN_COMMANDS` and dispatch |
