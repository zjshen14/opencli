# OpenCLI Roadmap

_Last updated: 2026-05-09_

This document is the source of truth for OpenCLI's strategic direction. It is paired with [GitHub Milestones](https://github.com/zjshen14/opencli/milestones) for issue grouping and progress tracking — milestones reflect this doc, not the other way around.

## Vision

> **OpenCLI is the open, provider-agnostic, sandboxed coding agent — built to embed (CI, scripts, MCP) as well as run interactively.**

## Strategic positioning

The dominant agents are vendor channels: Claude Code is Anthropic's, Codex is OpenAI's, Gemini CLI / Antigravity are Google's. There is real space for a serious, open, **multi-provider** agent. OpenCode is the closest competitor but is TUI- and product-focused, not architecture-focused.

We commit to three positioning angles, in this order of weight:

1. **Provider-agnostic** _(primary identity)_ — first-class support for Anthropic, Gemini, OpenAI, Kimi, Qwen, DeepSeek, and local models via OpenAI-compatible proxies. Cross-vendor model routing (architect / editor split) is the marquee differentiator.
2. **Headless-first** _(secondary identity)_ — designed for CI, scripting, and embedding. JSON event stream, MCP server mode, stable exit contracts, library entry point.
3. **Skills reference implementation** _(tertiary)_ — canonical [agentskills.io](https://agentskills.io) runner. Backlog only; not on the critical path.

**Sandboxing is foundational, not a feature.** Every tool that touches the system inherits a runtime isolation boundary. We build the abstraction before expanding the tool surface (MCP, etc.) so it doesn't get retrofitted under pressure.

## Phase A — Sandbox + table-stakes

**Goal:** A new user trying OpenCLI never asks "why doesn't it have X?" for the obvious things. The `bash` tool stops being scary by default.

| # | Milestone | Notes |
|---|---|---|
| **A1** | **Sandbox runtime for `bash`** | macOS `sandbox-exec` profile + Linux `bwrap`. `--sandbox=auto/strict/off`; default `auto` (deny network + writes outside CWD). Container mode deferred to C4. |
| **A2** | **MCP client** | Load servers from `~/.opencli/mcp.json`, surface their tools through `ToolRegistry`, inherit A1 sandbox + HITL confirmation. |
| **A3** | **Git-snapshot rewind** | `git stash create` before each write tool; `/rewind` pops to last snapshot. Independent of sandbox. |
| **A4** | **`@file` mentions + persistent history** | Resolve `@path` in input; persist history per-cwd to `~/.opencli/history`. |
| **A5** | **`/compact` + `/context`** ([#26](https://github.com/zjshen14/opencli/issues/26)) | LLM-summarize at threshold; token bar in REPL footer. |
| **A6** | **Inline diffs + compact tool rows** | Closes [cli-ux-research.md](cli-ux-research.md) Tier-1 items. Renderer-only changes. |

**Sequencing decision: sandbox (A1) before MCP (A2).** MCP-loaded tools should inherit isolation from day one rather than be retrofitted later.

**Risk:** sandbox profiles are fiddly cross-platform. Timebox A1 at 1 week; if it bleeds, ship macOS first and gate Linux behind a flag.

## Phase B — Provider-agnostic identity

**Goal:** A user can point OpenCLI at any major model, mix vendors per task stage, and run through a proxy.

| # | Milestone | Notes |
|---|---|---|
| **B1** | **Provider override + `--base-url`** ([#54](https://github.com/zjshen14/opencli/issues/54)) | _OpenAI client already shipped_ (`src/providers/openai.ts`). B1 now: explicit `provider` config field + `--base-url` for LiteLLM / Ollama / vLLM / corporate proxies. |
| **B2** | **Mature OpenAI client** | Responses API (native web search); o-series reasoning handling; usage token reporting. Completes parity with Gemini + Anthropic clients. |
| **B3** | **Structured prompt builder** ([#39](https://github.com/zjshen14/opencli/issues/39)) | Required scaffolding for per-provider prompt variations and the architect/editor split. |
| **B4** | **`AgentContext` as serializable value type** ([#63](https://github.com/zjshen14/opencli/issues/63)) | Required so context can flow from architect-stage to editor-stage cleanly. Replaces `reconstructMessages()`. |
| **B5** | **Architect / editor model routing** | **Marquee Angle-1 feature.** Phase B5a: single-vendor (Aider parity). Phase B5b: cross-vendor (e.g. Opus plans, Qwen Coder edits). Nobody ships B5b well today. |
| **B6** | **Kimi + Qwen clients** | Demonstrates "really multi-provider," not just three brands. Requires B1 plumbing. |
| **B7** | **Native web search Phase 1** ([#37](https://github.com/zjshen14/opencli/issues/37)) | Anthropic + Gemini provider-native. OpenAI Responses API via B2. |
| **B8** | **LSP for TypeScript** | Quality differentiator for the language we self-dogfood. Bundles a tsserver client. Future: per-language plugins. |

> **Note (2026-05-09):** OpenAI client was implemented before Phase B was drafted; the original B1 slot is now repurposed for provider-override plumbing. Remaining OpenAI work moves to B2.

**Sequencing decision: B5 ships in two stages.** B5a (single-vendor) gives us Aider parity quickly and validates the routing surface. B5b (cross-vendor) is the harder design problem — context translation, tool-call format negotiation, prompt-builder variants — and lands after we've stress-tested B5a in real use.

## Phase C — Headless-first

**Goal:** OpenCLI is the agent you embed.

| # | Milestone | Notes |
|---|---|---|
| **C1** | **JSON event mode for `run`** | `--output=json` streams existing observability events to stdout. Stable schema, semver'd. |
| **C2** | **MCP server mode** | OpenCLI itself exposed as an MCP server — Claude Desktop, Codex, Cursor can call it as a sub-agent. |
| **C3** | **Hooks** | Pre/post-tool, stop, prompt-submit. Mirrors Claude Code's surface; key for CI integration. |
| **C4** | **Container sandbox option** | `--sandbox=docker` for users who want stronger isolation than A1 provides. |
| **C5** | **Sub-agent dispatch** | Once B4 lands, a `task` tool that spawns child agents with their own context becomes straightforward. |

## Deferred (with rationale)

| Item | Issue | Why deferred |
|---|---|---|
| Agentic loop → state machine | [#60](https://github.com/zjshen14/opencli/issues/60) | Current loop is 225 LOC with two guards. Refactor only justifies itself when we add a third or fourth cross-cutting concern (cost limits, pause/resume). |
| Tool composition (`atomic_edit`) | [#65](https://github.com/zjshen14/opencli/issues/65) | Don't add the interface speculatively. Wait for a concrete composed tool a user wants. |
| Skills as directives | [#61](https://github.com/zjshen14/opencli/issues/61) | Worth doing but Angle 3, not Angle 1. Backlog. |
| Gemini Interactions API | [#1](https://github.com/zjshen14/opencli/issues/1) | Still unstable upstream. |
| TUI migration (Ink / Bubble Tea) | — | Only if vim mode / multi-pane becomes a real ask. |
| `repl.ts` split | [#52](https://github.com/zjshen14/opencli/issues/52) | Still good hygiene. Fold into A6 if it ends up touching the same code. |

## Closeable now

| Issue | Reason |
|---|---|
| [#4](https://github.com/zjshen14/opencli/issues/4) — infinite loop on failing tool calls | Superseded by max-turns + stuck-loop guards already in `agent.ts`. |
| [#35](https://github.com/zjshen14/opencli/issues/35) — `/plan` approval UX | Latest `readLine` text-menu fix has shipped; verify and close. |

## How this rolls out

- Each milestone gets a tracking issue tagged `roadmap-A` / `roadmap-B` / `roadmap-C`.
- A GitHub Milestone per phase groups them; the milestone description links back to this doc.
- This doc is updated **whenever a phase boundary moves, an angle is re-prioritized, or a deferred item gets pulled forward** — not for routine progress (that lives in the issues).

## Decisions still open

These were left open at the time of writing and can revise the roadmap:

1. **Kimi/Qwen order in Phase B.** Currently B6 after B1 proxy plumbing. Could pull earlier if adoption justifies it — both require the `--base-url` infrastructure from B1 anyway.
2. **B8 (LSP) scope.** TypeScript-only first, or design for multi-language from the start? Multi-language is a meaningful effort lift.
3. **C4 (container sandbox) vs. native sandbox sufficiency.** If A1 covers most users' threat model, C4 may stay deferred indefinitely.
