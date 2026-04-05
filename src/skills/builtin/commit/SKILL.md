---
name: commit
description: Draft and create a git commit for staged changes. Use when asked to commit.
allowed-tools: Bash
disable-agent-invocation: true
---

Create a git commit for the currently staged changes.

Current staged diff:
!{git diff --staged}

Steps:
1. Analyse the diff to understand what changed and why
2. Draft a concise commit message: imperative mood, under 72 chars, focused on "why" not "what"
3. Run: git commit -m "<message>"

If nothing is staged, report that and suggest running `git add` first.
