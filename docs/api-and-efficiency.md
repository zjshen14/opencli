# API Choice and Token Efficiency

> This document covers the Gemini provider specifically (`src/model/gemini.ts`). The Anthropic client uses the standard `messages.stream()` API which is stateless by design; equivalent token efficiency considerations for Anthropic are tracked separately.

## API Choice: `generateContent` vs Interactions API

### Current: `generateContent` (stateless)

We use `client.models.generateContentStream()` from `@google/genai`. On every turn we resend the full conversation history (`Message[]`) plus system instruction and tool definitions. This causes linear growth in input tokens as the conversation grows.

**Why we chose it:**
- Stable, well-documented, works reliably with all Gemini models
- The Interactions API had structural breaking changes as recently as March 2026 (v1.46.0)
- Tools and system instruction must be resent every turn on the Interactions API anyway — so for an agentic CLI where those are substantial, the savings are smaller than advertised

### Future: Interactions API (stateful) — Phase 2

The Interactions API (`client.interactions.create()`, available in `@google/genai >= 1.33.0`) allows stateful sessions via `previous_interaction_id`. The server retains message history between turns; the client only sends the new message.

**Measured savings (10-turn conversation):**
- ~79% reduction in input tokens
- ~85% reduction in payload size
- `generateContent` payload grows to 13× larger by turn 10

**Limitation:** Tool definitions and system instruction are **not** retained server-side and must be resent every turn. Net savings for this project will be lower than 79% but still meaningful for long sessions.

**Migration scope:** Contained to `src/model/gemini.ts` and `src/model/schema.ts` only. The rest of the system communicates via `StreamEvent` and `Message[]` and is unaffected.

**Track as:** GitHub issue `#2` — Migrate to Interactions API for stateful conversation history.

---

## Token Efficiency Strategy

### 1. Implicit caching (active, zero config)

Gemini 2.5+ and 3.x models cache KV state automatically when consecutive requests share a common token prefix. Cached tokens are billed at **90% discount** (Gemini 3.x) or **75% discount** (Gemini 2.5).

**Minimum qualifying prefix:** 1,024 tokens (2.5 Flash), 2,048 tokens (2.5 Pro), 4,096 tokens (Gemini 3 Pro).

**To maximise cache hits, the request must be structured with static content first:**

```
[system instruction]     ← static every turn  ← cache hits here
[tool definitions]       ← static every turn  ← cache hits here
[growing message history] ← changes each turn
```

**Our implementation:** `ContextManager.getSystemInstruction()` returns the system prompt. Tool definitions are passed separately as `functionDeclarations` in every `stream()` call. Both are static per session, so they form a consistent prefix — implicit caching should apply.

Verify cache usage by checking `usage_metadata.cached_content_token_count` in API responses.

### 2. Explicit context caching (future option)

Manually upload a `CachedContent` object containing the system prompt and tool definitions. Reference it by ID in subsequent calls. Guarantees cache hits rather than relying on opportunistic implicit caching.

**When it makes sense:** Sessions longer than ~20 turns where the system prompt + tool definitions exceed ~3,000 tokens and storage fees are outweighed by savings. At $1.00/million tokens/hour storage, explicit caching is cost-negative for short sessions.

**Not implemented yet.** Implicit caching covers the same ground for most sessions.

### 3. Context pruning (active)

`ContextManager` keeps a sliding window of the last 50 messages. Old turns are pruned to prevent unbounded token growth. Skill content is protected from pruning (tagged with `<skill_content>` markers).

### 4. Tool definition size

Each tool's `description` and parameter `description` fields are included in every request. Keep them concise — they count toward every turn's input tokens.

---

## Summary

| Mechanism | Status | Discount | Notes |
|---|---|---|---|
| Implicit prefix caching | Active (model feature) | 90% on cached tokens | Requires static prefix ordering |
| Context pruning | Active (50-message window) | Reduces history tokens | Protects skill content |
| Interactions API stateful | Phase 2 | ~79% input reduction | Beta, breaking changes risk |
| Explicit context caching | Not implemented | Guaranteed cache hits | Worth it only for long sessions |
