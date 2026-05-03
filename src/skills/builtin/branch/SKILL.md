---
name: branch
description: Create or switch to a feature branch, typically tied to a GitHub issue. Use when asked to create a branch or start work on an issue.
allowed-tools: Bash
---

Manage git branches for this repository.

Current branch state:
!{git branch -a 2>/dev/null | head -20 || echo "(not a git repo)"}

Open issues (for branch naming):
!{gh issue list --limit 10 --json number,title,state 2>/dev/null || echo "(gh CLI not available)"}

Task: $ARGUMENTS

---

Branch naming convention:
- Feature: `feature/<issue-number>-<short-slug>` (e.g. `feature/42-add-gh-skills`)
- Bug fix: `fix/<issue-number>-<short-slug>` (e.g. `fix/17-loop-on-empty-response`)
- No issue: `feature/<short-slug>` or `fix/<short-slug>`

Steps:
1. Determine the branch name from the task description or issue number
2. Create and switch: `git checkout -b feature/42-add-gh-skills`
3. Confirm: `git branch --show-current`

If the branch already exists, switch to it: `git checkout <branch-name>`
