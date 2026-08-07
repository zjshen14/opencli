# Prompt-injection defenses

_Status: Partially implemented (system-prompt framing) — structural layers shipped in companion advisories; provenance-tracking confirmation bump `Ready for implementation`._

## Problem

OpenCLI has no structural separation between trusted instructions (the user's messages) and untrusted data (file `read` contents, `web_fetch` bodies, `grep`/`glob` matches, MCP tool results, skill bodies). All of it is concatenated into the conversation and treated by the LLM as instructions.

The only mitigation prior to this work was a soft system-prompt rule ("Never read ... credentials"). A soft rule is not a security control: content inside tool output (a hostile repo's `README.md`, a fetched web page, an MCP tool response) can issue directives the model will follow. This is the root enabler that turned the read/symlink, `web_fetch`, and `--yes` findings into remotely exploitable chains.

## Threat model

- **Hostile repository.** Victim clones a repo and runs `opencli` in it. Repo files (`README`, source comments, `.opencli/`) carry injected instructions.
- **Fetched content.** The agent (or a prompt) calls `web_fetch` on an attacker-controlled URL; the response body carries injected instructions.
- **MCP tool output.** A compromised or malicious MCP server returns tool results containing injected instructions.
- **Goal of the adversary.** Read a secret (`~/.ssh/id_rsa`, `~/.aws/credentials`, a cloud-metadata response) and exfiltrate it via `web_fetch`; run a destructive shell command; modify files outside the project; or plant persistence.

## Defense in depth

This advisory lands the prompt-level framing and documents the layered strategy. The structural layers — which actually bound the blast radius independent of the model — ship in companion advisories:

1. **Read-path restriction** (GHSA-5v6f-c99j-7m36): `read`, `grep`, `glob`, and `ls` all require confirmation for paths outside cwd or for credential basenames; `write`/`edit`/`multi_edit` use symlink-aware containment. An injected agent cannot silently read `~/.ssh/id_rsa` — and `grep` is gated the same way, because it returns matching *lines* and is therefore an equivalent exfiltration primitive.
2. **`web_fetch` host guard** (GHSA-9gqj-5w58-2j6v): SSRF/private/loopback/link-local hosts are blocked, and HTTP redirects are re-validated per hop, closing the cloud-metadata and internal-service **read** vector. This does **not** close exfiltration — see "Open problem: exfiltration" below.
3. **`--yes` deny + blocklist** (GHSA-hx58-45j4-fr7m): catastrophic commands and the user's deny list are honoured even under `--yes`.
4. **Session-log redaction** (GHSA-x245-5r32-45m5): secrets that do reach the log are masked.
5. **System-prompt framing** (this advisory, soft): tell the model tool output is data. Reinforces 1–4 but is not relied upon alone.

## What landed here

- A new `## Untrusted content` section in `DEFAULT_SYSTEM_INSTRUCTION` (`src/core/prompt.ts`) that frames tool output as data, names prompt injection, and instructs the model to surface — not obey — actions requested only by untrusted content.

> ⚠ This is prompt text. Its effectiveness is **model-dependent** and is **not** verified by the unit test, which only asserts the text is *present*. Do not mistake the passing test for evidence that the framing actually changes model behaviour. The structural layers (1–4) are what bound the blast radius; this layer is reinforcement only.

## Open problem: exfiltration is still open

After all four structural layers land, an injected agent that does obtain a secret (e.g. from a project file it was legitimately asked to read) can still **exfiltrate** it: `web_fetch` to a *public* attacker-controlled host is allowed by design, and the `auto` sandbox permits outbound network. None of the current layers gate "send data out". The provenance-tracking bump below is the mechanism that would actually address it — a `web_fetch` (or `bash` with `curl`) immediately after untrusted content was consumed is precisely the signal worth gating. Until that ships, exfiltration to public hosts is the open gap; the layers here bound the secret-read, private-endpoint, and destruction surfaces, not the outbound channel.

## Follow-up: provenance-tracking confirmation bump (ready for implementation)

The strongest structural defense not yet shipped is a **confirmation bump** keyed on content provenance. Sketch:

- Tag each `function_result` with the *source* of the data it returned: `read` (path inside vs. outside cwd), `web_fetch` (host), `mcp__*`.
- Track a per-turn (or per-session) flag: "this turn consumed untrusted content" (any `read` outside cwd, any `web_fetch`, any MCP result).
- While that flag is set, raise `write`/`edit`/`multi_edit`/`bash` to `requiresConfirmation=true` in the executor, regardless of their own predicates. So an action that only makes sense because untrusted content asked for it always hits the HITL gate.

Implementation notes:

- The executor (`src/core/executor.ts`) already computes `requiresConfirmation` per call; a "consumed-untrusted-this-turn" signal can be threaded via `ExecutorDeps` and checked alongside the tool's own predicate.
- The provenance tag belongs on `FunctionResultPart` (`src/providers/types.ts`), added when the executor builds results, and read back at the top of the next turn.
- Keep the flag scoped to "since the last user message" so a legitimate multi-step task that reads external docs early doesn't stay elevated forever.

This is deliberately a follow-up rather than part of this advisory: it touches the executor and the message types, and deserves its own review + tests. The companion layers close the destructive paths and the secret-read / private-endpoint paths; the bump is what would constrain exfiltration to public hosts (see "Open problem" above).

## What is out of scope

- Fully solving prompt injection is an open research problem. The goal of this work is **bounding the blast radius** so an injected agent cannot reach secrets, private endpoints, or destructive commands without an explicit user prompt — not guaranteeing the model ignores injected text.
- Sandboxed execution (`--sandbox strict`) remains the recommendation for real isolation; the auto-sandbox network allowance is documented separately (`docs/design/a7-sandbox-loosen-auto.md`).

## References

- Advisory: GHSA-v5f9-ffp2-x7p3
- Companion structural fixes: GHSA-5v6f-c99j-7m36, GHSA-9gqj-5w58-2j6v, GHSA-hx58-45j4-fr7m, GHSA-x245-5r32-45m5
- `src/core/prompt.ts` (`DEFAULT_SYSTEM_INSTRUCTION`, `## Untrusted content`)
- `src/core/executor.ts` (future home of the confirmation bump)
