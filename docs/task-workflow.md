# Task Workflow

When you're assigned a task in this project, follow this workflow to ensure your work fits the codebase conventions and completes cleanly.

---

## 1. Understand the Task

**Read the GitHub issue carefully.** Extract:
- What needs to be done (feature, bug fix, refactor)?
- What are the constraints (performance, backwards-compatibility, scope)?
- Are there related issues or prior context (linked PRs, design docs, conversations)?
- What's the acceptance criteria (how do we know it's done)?

If you're resuming work or joining mid-conversation, check the issue for progress updates posted by earlier agents — they summarize what was done, what failed, and what remains.

---

## 2. Check Project Conventions

Scan these documents to orient yourself:

- **[CLAUDE.md](../CLAUDE.md)** — project overview, source structure, architecture, key conventions, issue management, branching strategy, configuration
- **[docs/engineering-practices.md](engineering-practices.md)** — testing (colocate, use real filesystem for file tools), TypeScript (strict mode, explicit return types), code organization (no circular imports), formatting (Prettier), git practices

You don't need to memorize them — skim for the relevant sections. Common ones:
- Testing: colocate `.test.ts` next to source, use real filesystem, mock at boundaries only
- Code: no circular imports, each layer owns its concern, thread types through the system
- Git: one logical change per commit, link the issue with `Closes #<number>`, add co-author trailer
- Formatting: run `npm run format` before committing

---

## 3. Plan Your Approach

### Decide: Direct to `main` or feature branch?

From [CLAUDE.md — Branching Strategy](../CLAUDE.md#branching-strategy):
- **Direct to `main`**: small bug fixes, scoped features, docs, low-risk changes (well-tested, isolated)
- **Feature branch** (`feature/issue-123` or `fix/issue-123`): large architectural changes, experimental features, complex multi-component refactors that need testing before merge

If unsure, ask the tech lead or err toward a branch — it's easier to merge clean than to revert a risky main commit.

### For non-trivial changes, use Plan mode

If the task is complex (multiple files, architectural decision, significant refactor), use Claude Code's plan mode:
```
/plan <task description>
```
This produces a step-by-step implementation plan for you to review before coding begins. You can redirect, approve, or ask for refinement. Planning upfront prevents wasted work.

### Consult the design docs

If the issue references a milestone (`A4`, `A5`, etc.), read the corresponding design doc in `docs/design/`. It explains the problem, solution, scope, and implementation strategy. This is the source of truth for phased work.

---

## 4. Implement and Verify

### Code

Follow the conventions from step 2. Key ones:
- Colocate tests: `src/foo/bar.ts` → `src/foo/bar.test.ts`
- Use real filesystem for file tool tests (no mocks)
- Strict TypeScript (no `@ts-ignore`, explicit return types on public methods)
- Thread types through the system instead of raw strings or `Record<string, unknown>`
- No circular imports: `cli → core/providers/tools/skills/state`

### Test before committing

```bash
npm run typecheck && npm run lint && npm run format:check && npm test
```

All four must pass. If they don't, fix the issues before committing.

- **typecheck**: TypeScript strict mode violations
- **lint**: ESLint (@typescript-eslint/recommended, no unused vars)
- **format:check**: Prettier violations (run `npm run format` to fix)
- **test**: all tests must pass (unit + integration)

### Never commit secrets

Before committing, check:
```bash
git diff --cached | grep -i "AIza\|api_key\|secret"
```

API keys go in `.env` only (which is gitignored).

---

## 5. Commit and Link the Issue

### Commit message

```
<imperative, present tense subject>

<optional body explaining why, not what>

Closes #<issue_number>
Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

Examples:
```
fix: skip orphaned tool_result entries instead of silently producing corrupt Message[]

Closes #78
Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

```
refactor: extract duplicate retry loop into shared withRetry utility

Reduces duplication across Gemini, Anthropic, OpenAI clients without changing behavior.

Closes #75
Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

**Use `Closes` if the commit fully resolves the issue.** Use `Part of` or `References` if it's partial work.

### If you forget to link in the commit message

Manually comment on the GitHub issue with the commit hash — e.g., "landed in abc1234". This establishes the link even if the commit message didn't include it.

---

## 6. Multi-Phase Work

If the issue is large and splits across multiple commits/phases:

**After completing each phase,** post a comment on the GitHub issue summarizing:
- What you completed (1-2 sentence summary)
- Which commit(s) landed (hash + message)
- What remains open (next phases, blockers, dependencies)

Example:
```
✅ **Phase 1 complete** (commit abc1234)
- Implemented `/compact` and `/context` slash commands
- Added core compaction algorithm with structured summarization
- All 14 unit tests passing

📋 **Phase 2 (blocked):**
- Auto-compact trigger logic (waiting on Phase 2 real-session data)
- Compaction model failure handling
- Turn-boundary detection
```

This keeps the issue as the canonical record of progress and makes it easy to resume work in a future session without re-reading code diffs.

---

## 7. Pull Requests

**When to create a PR:** Feature branches require a PR before merge. Direct-to-main commits for small fixes don't need a PR.

**PR template:**
```markdown
## Summary
<1-3 bullet points of what changed and why>

## Test plan
- [ ] `npm run typecheck && npm run lint && npm run format:check && npm test` — all pass
- [ ] <manual testing steps if UI/behavior changes>
- [ ] <edge cases or regressions to check>

🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

**What to explain in the description:**
- *Why* the change (problem it solves, constraint it addresses)
- *What* changed (file list, function signature changes, config changes)
- How to test it (steps to verify, expected behavior)
- Any decisions or trade-offs (why this approach over alternatives)

**Link the issue:** Use `Closes #<number>` in the PR description to auto-close the issue when merged.

---

## Quick Reference

| Situation | Action |
|-----------|--------|
| Small bug fix, isolated, low-risk | Commit directly to `main` |
| Complex feature, multiple files, experimental | Create feature branch, submit PR |
| Unsure which approach | Ask tech lead or use feature branch |
| Task is complex (multiple steps, design decision) | Use `/plan` mode first |
| Before committing | `npm run typecheck && npm run lint && npm run format:check && npm test` |
| Commit message | Imperative mood, link with `Closes #<number>`, include co-author trailer |
| Multi-phase task | Post progress update on issue after each phase |
| Forgot to link in commit | Comment on issue with commit hash |

---

## Common Pitfalls

- **Committing without running tests.** Don't do this. All four checks must pass.
- **Committing API keys.** Check `git diff --cached` before committing.
- **Not linking the issue.** Use `Closes #<number>` or manually comment on the issue.
- **Forgetting the co-author trailer.** Always include it in the commit message.
- **No plan for complex work.** Use `/plan` mode if the task spans multiple files or requires a design decision.
- **Mocking the filesystem in file tool tests.** Use a real `tmpdir` instead. Mocks hide bugs.
- **Circular imports.** Check the dependency direction: `cli → core/providers/tools/skills/state`. Nothing in a lower layer imports from a higher layer.

---

## Getting Help

- **Questions about conventions?** Check CLAUDE.md and docs/engineering-practices.md.
- **Questions about project architecture?** Read docs/architecture.md.
- **Stuck on a task?** Post in the issue or ask the tech lead.
- **Need to understand a design decision?** Look for the corresponding design doc in docs/design/.
