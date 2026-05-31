# OpenCLI vs Claude Code vs Gemini CLI vs Aider

A practical, opinionated comparison of open-source and vendor terminal AI coding agents — and where **OpenCLI** fits.

> _Last updated: mid-2026. Other tools move fast; if something here is stale, please [open an issue](https://github.com/zjshen14/opencli/issues) and we'll fix it. The goal is an honest map, not a takedown._

## TL;DR

- **You're locked into one vendor's model and that's fine** → use that vendor's first-party CLI (Claude Code for Claude, Gemini CLI for Gemini). They're polished and deeply tuned for their own model.
- **You want one tool that works across providers, is MIT-licensed, and sandboxes shell commands at the OS level** → that's the gap **OpenCLI** is built for.
- **You live in git and want tight diff/commit-centric pairing** → Aider is excellent and battle-tested.

## At a glance

| | **OpenCLI** | **Claude Code** | **Gemini CLI** | **Aider** |
|---|:---:|:---:|:---:|:---:|
| Model providers | Gemini · Claude · any OpenAI-compatible | Claude | Gemini | Many (OpenAI, Anthropic, local, …) |
| License | MIT (open source) | Proprietary | Apache-2.0 (open source) | Apache-2.0 (open source) |
| OS-level shell sandbox | Built in (`sandbox-exec` / `bwrap`) | — | — | — |
| Agent Skills (open standard) | Yes | Yes (slash commands / skills) | Yes | — |
| MCP support | Yes | Yes | Yes | Limited |
| Plan / approve before edits | Yes (`/plan`) | Yes | Yes | Yes (diff-based) |
| Requires git | No | No | No | Yes |

_This table is a starting point, not gospel — capabilities change release to release. Verify against each project's current docs for anything load-bearing to your decision._

## What makes OpenCLI different

OpenCLI deliberately occupies the lane the first-party CLIs structurally can't: **provider-agnostic, fully open, and safe by default.**

### 1. Runs on any model — no rewrite, no lock-in
Switch between Gemini, Claude, or any OpenAI-compatible endpoint (including local inference via a custom base URL) with a single flag:

```bash
opencli run --model claude-sonnet-4-6 "refactor this module"
opencli run --model gemini-3.1-pro-preview "refactor this module"
opencli run --provider openai --base-url http://localhost:4000 "…"
```

The agent loop, tools, skills, and UX stay identical across providers. You're never re-learning a tool or re-writing automation because you changed models.

### 2. Sandboxed shell execution by default
Every command the agent runs goes through an OS-level sandbox — `sandbox-exec` on macOS, `bwrap` on Linux — so the agent **physically cannot** write to `/etc`, `~/.ssh`, `~/.aws`, or other credential paths. This is enforced by the operating system, not by prompting the model to "be careful."

```bash
opencli chat --sandbox strict   # no external network; writes only to CWD + tmp
```

This is the differentiator most worth understanding: AI agents that run shell commands are a real foot-gun, and OpenCLI treats isolation as foundational rather than an add-on.

### 3. Open standard skills + MCP
Skills are plain `SKILL.md` files following the [Agent Skills open standard](https://agentskills.io), so skills written for Claude Code or Gemini CLI work in OpenCLI unchanged. Any [Model Context Protocol](https://modelcontextprotocol.io) server plugs in as agent tools.

### 4. MIT-licensed and embeddable
MIT means you can fork it, vendor it, embed it in CI, or build a product on top without legal friction.

## Honest trade-offs

OpenCLI is a young project. Be clear-eyed:

- **Maturity & ecosystem.** Claude Code and Gemini CLI are backed by large teams and have bigger ecosystems, IDE integrations, and battle-testing. OpenCLI is a lean, fast-moving prototype.
- **First-party tuning.** A vendor's own CLI is tuned end-to-end for its model's quirks; a provider-agnostic tool optimizes for the common denominator.
- **Git-native workflows.** If your whole workflow is commit-by-commit pairing, Aider's git-first design may fit your hands better.

If those matter more to you than provider freedom + open licensing + OS-level safety, one of the alternatives may be the better pick — and that's a fine outcome.

## When to choose which

| If you… | Consider |
|---|---|
| Are all-in on Claude and want the most polished Claude experience | Claude Code |
| Are all-in on Gemini / want a generous free tier | Gemini CLI |
| Want git-centric, diff-driven pair programming | Aider |
| Want one open, MIT tool across providers with sandboxed execution | **OpenCLI** |
| Need to embed an agent in CI/scripts without vendor lock-in | **OpenCLI** |

## Try OpenCLI

```bash
npm install -g @zjshen/opencli
export ANTHROPIC_API_KEY=...   # or GEMINI_API_KEY
opencli
```

See the [README](../README.md) for the full feature tour, and the [architecture docs](architecture.md) if you want to understand how the provider abstraction works under the hood.
