---
name: gh-pr
description: Create, review, or manage GitHub pull requests. Use when asked to open, check, or merge a PR.
allowed-tools: Bash
---

Manage GitHub pull requests for this repository.

Current PR status:
!{gh pr status 2>/dev/null || echo "(gh CLI not available or no GitHub remote)"}

Branch context:
!{git log --oneline -10 2>/dev/null || echo ""}

Task: $ARGUMENTS

---

Common operations:

- **Create**: `gh pr create --title "Title" --body "Body" [--base main] [--draft] [--assignee @me]`
- **View**: `gh pr view [<number>]`
- **List**: `gh pr list [--state open|closed|merged] [--author <user>]`
- **Check CI**: `gh pr checks [<number>]`
- **Review**: `gh pr review <number> --approve|--request-changes|--comment --body "..."`
- **Merge**: `gh pr merge <number> [--squash|--merge|--rebase] [--delete-branch]`
- **Checkout**: `gh pr checkout <number>`
- **Diff**: `gh pr diff [<number>]`

When creating a PR:
1. Title: imperative mood, ≤72 chars (e.g. "Add gh-pr skill")
2. Body: summary of changes (what and why), test plan, any breaking changes
3. Link the related issue with "Closes #N" or "Part of #N" in the body
4. Use `--draft` if the work is not yet ready for review
5. Do not push or create the PR without explicit user approval
