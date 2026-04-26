# Engineering Practices

Practices established in this project. Follow these when adding or changing code.

## Testing

**Colocate tests with source.** Every module has a `.test.ts` file next to it:
```
src/agent/context.ts
src/agent/context.test.ts
```
A missing test file is immediately visible. Moving a module moves its test automatically.

**Use a `tests/` directory only for integration tests** that span multiple modules and don't belong to any single file.

**Test real behaviour, not implementation details.** Write tests against the public interface. If an internal field changes, tests should not break unless behaviour changed.

**Use the filesystem for file tool tests.** The `read`, `write`, `edit`, `glob`, `grep` tools are tested against a real `tmpdir` created in `beforeEach` and cleaned up in `afterEach`. No mocking of `fs` — mocks hide real bugs.

**Mock at boundaries.** LLM clients (`GeminiClient`, `AnthropicClient`) and `SkillRegistry` are mocked in agent tests because they cross a system boundary. Internal collaborators (e.g. `ContextManager`, `ToolRegistry`) are used directly.

**Run before every commit:**
```bash
npm run typecheck && npm run lint && npm run format:check && npm test
```

---

## TypeScript

**Strict mode is on.** No `@ts-ignore`. Use `unknown` over `any`; cast through `unknown` when necessary (e.g. `as unknown as X`).

**Prefer explicit return types on public methods** of classes. Internal helpers can rely on inference.

**Thread domain types through the system.** Don't use raw strings or `Record<string, unknown>` where a named type exists. Example: `thoughtSignature` is explicitly typed on `FunctionCallPart` and `FunctionResultPart` and threaded all the way through rather than attached ad-hoc.

**ESLint rule:** unused variables must be prefixed with `_` to suppress the error, not silenced with a comment.

---

## Code Organisation

**Each layer owns its concern exclusively:**
- Model Layer (`src/model/`) — LLM provider abstraction only. Never touches the filesystem. Provider SDKs (`@google/genai`, `@anthropic-ai/sdk`) are imported only inside the respective client files.
- Tool System (`src/tools/`) — tool execution only. Never imports provider SDKs.
- Agent Core (`src/agent/`) — orchestration only. Depends on `LLMClient` interface, never a concrete provider.
- Skill System (`src/skills/`) — SKILL.md parsing and injection only.

**No circular imports.** Dependency direction: `cli → agent → model/tools/skills/state`. Nothing in `model/` imports from `agent/`.

**Don't add abstraction for a single use case.** Three similar lines of code is better than a premature helper.

---

## Formatting

Prettier is the enforcer. Config in `.prettierrc`: `printWidth: 100`, double quotes, trailing commas.

```bash
npm run format        # fix
npm run format:check  # CI check
```

Don't manually format — run Prettier.

---

## Documentation

**Architecture decisions go in `docs/`.** When a non-obvious technical decision is made (API choice, caching strategy, layering boundary), document it. Future contributors should understand *why*, not just *what*.

Current docs:
- `docs/architecture.md` — system design and component reference
- `docs/api-and-efficiency.md` — Gemini API choice and token efficiency strategy
- `docs/cli-ux-research.md` — REPL UX research and feature backlog
- `docs/cli-ui-research.md` — visual design research (rendering, popups, spinners)
- `docs/engineering-practices.md` — this file

**CLAUDE.md is for Claude Code.** Keep it current when commands, file structure, or key conventions change. It's the first thing Claude reads.

---

## Git, Branching & Issue Management

**One logical change per commit.** Don't bundle unrelated changes.

**Commit message format:** imperative mood, present tense, concise subject line. Body explains *why* if non-obvious.

**Linking & Closing Issues:**
- Always link your work to the relevant GitHub issue.
- To auto-close an issue, use `Closes #<issue_number>` or `Fixes #<issue_number>` in the commit message of the commit that fully resolves it.
- If a commit is related but doesn't resolve the issue entirely, use `Part of #<issue_number>` or `References #<issue_number>`.
- If you forget to link an issue in the commit message, manually comment on the issue with the commit hash to establish the link.

**Branching Strategy:**
- **Direct to `main`**: Acceptable for quick bug fixes, small scoped features, documentation updates, and changes that are well-tested and low-risk. When working with AI coding assistants, direct commits to `main` are standard for low-risk changes.
- **Issue Branches (`feature/issue-123` or `fix/issue-123`)**: Required for large architectural changes, experimental features, or complex refactors that span multiple components or require extensive testing before integration. Merge via Pull Request once verified.

**Never commit secrets.** `.env` is gitignored. API keys go in `.env` only. Run `git diff --cached | grep -i "AIza\|api_key\|secret"` before committing if unsure.

**Always include the co-author trailer:**
```
Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
```

---

## Security

**Validate at boundaries.** The `bash` tool blocks dangerous patterns (`rm -rf`, `git push --force`, etc.) at execution time. The `edit` tool requires exact unique matches to prevent unintended edits.

**No path traversal.** File tools use `resolve()` to normalise paths. Don't add file tools that accept raw user-supplied paths without resolving them first.

**Sensitive config** (API keys) is read from environment variables first (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`), config file second. Never logged.
