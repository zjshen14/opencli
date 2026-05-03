---
name: gh-issue
description: Create, view, list, or comment on GitHub issues. Use when asked to file, open, or manage GitHub issues.
allowed-tools: Bash
---

Manage GitHub issues for this repository.

Current open issues:
!{gh issue list --limit 10 --json number,title,state,labels 2>/dev/null || echo "(gh CLI not available or no GitHub remote)"}

Recent commits for context:
!{git log --oneline -5 2>/dev/null || echo ""}

Task: $ARGUMENTS

---

Common operations:

- **Create**: `gh issue create --title "Title" --body "Body" [--label bug,enhancement] [--assignee @me]`
- **View**: `gh issue view <number>`
- **List**: `gh issue list [--state open|closed|all] [--label <label>] [--assignee <user>]`
- **Comment**: `gh issue comment <number> --body "Comment"`
- **Close**: `gh issue close <number> [--comment "Reason"]`
- **Edit**: `gh issue edit <number> [--title "New title"] [--body "New body"] [--add-label <label>]`

When creating an issue:
1. Draft a concise title in plain language (not imperative — describes the problem or feature, ≤72 chars)
2. Write a structured body: context/motivation, steps to reproduce (bugs) or acceptance criteria (features), any relevant code snippets
3. Apply appropriate labels if they exist in the repo (`gh label list`)
4. Confirm with the user before submitting unless they said "just do it"
