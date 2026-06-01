---
name: changelog
description: Generate a changelog or release notes from recent git history. Use when asked to write a changelog, summarize recent commits, or produce release notes.
allowed-tools: Bash Read
---

Generate a user-facing changelog grouped into Added / Changed / Fixed sections.

Recent git history:
!{git log --oneline -30 2>/dev/null || echo "(no git history available)"}

Recent tags:
!{git tag --sort=-creatordate 2>/dev/null | head -5 || echo "(no tags)"}

Scope: $ARGUMENTS

---

Steps:
1. If Scope is non-empty (e.g. a git ref range like `v1.2.0..HEAD` or a target version tag), run `git log --oneline <scope>` to get the relevant commits; otherwise use the recent history shown above.
2. Group commits into **Added**, **Changed**, and **Fixed** — skip merge commits and CI/chore noise.
3. Write clean, user-facing bullet points — rephrase commit messages for clarity rather than copying them verbatim.
4. Output as Markdown with a version heading if a version was specified.
