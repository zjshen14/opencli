# Skills

Skills are packaged prompt instructions (`SKILL.md` files) that get injected into the agent's context on activation. Unlike tools (which run code), skills deliver Markdown instructions for the model to follow using existing tools.

OpenCLI follows the [Agent Skills open standard](https://agentskills.io), which enables skill sharing across Claude Code, Gemini CLI, Cursor, and others.

---

## SKILL.md Format

```yaml
---
name: my-skill            # becomes /my-skill slash command; must match directory name
description: One line.    # shown to the model in the catalog — drives auto-activation
allowed-tools: Read Bash  # space-separated; these tools skip confirmation when the skill is active
disable-agent-invocation: true  # optional — omit to allow model self-activation
---

Skill body here. Markdown. Can reference $ARGUMENTS and !{shell commands}.
```

### Frontmatter fields

| Field | Required | Description |
|---|---|---|
| `name` | Yes | Slash command name; must match the containing directory |
| `description` | Yes | Shown to the model in the skill catalog; drives `activate_skill` self-selection |
| `allowed-tools` | No | Space-separated tool names that skip confirmation dialogs while this skill is active |
| `disable-agent-invocation` | No | `true` → user-only (model cannot self-activate); default: false |

---

## Body Syntax

### `$ARGUMENTS`

Replaced with whatever the user passed after the slash command:

```
/explain src/agent/core.ts line 42
```

→ `$ARGUMENTS` becomes `src/agent/core.ts line 42`.

If activated by the model via `activate_skill`, `$ARGUMENTS` is empty unless the model passes an argument.

### `!{shell command}`

Shell preprocessors run **at activation time**, before the body is injected into the context. The stdout of the command replaces the `!{…}` block.

```markdown
Open issues:
!{gh issue list --limit 10 --json number,title,state 2>/dev/null || echo "(gh not available)"}
```

Best practices:
- Always add a `|| echo "fallback"` — skills must not crash if a tool is missing
- Keep output short; the injected text counts against context
- Avoid commands with side effects; preprocessors run on every activation

---

## Discovery Paths

Skills are discovered in priority order — the first directory that contains a skill of a given name wins:

| Priority | Path | Scope |
|---|---|---|
| 1 (highest) | `<project>/.opencli/skills/<name>/SKILL.md` | Project-specific |
| 2 | `<project>/.agents/skills/<name>/SKILL.md` | Cross-client (agentskills.io) |
| 3 | `~/.opencli/skills/<name>/SKILL.md` | User-global |
| 4 (lowest) | Built-ins bundled with the CLI | Default |

A project-scoped skill with the same `name` as a built-in **overrides** the built-in for that project.

---

## Catalog Injection

At session start, `SkillRegistry.discover()` is called and the catalog (name + description for every discovered skill) is injected into the system prompt via `{SKILL_CATALOG}`. This lets the model call `activate_skill("<name>")` on its own when the task matches a skill's description — no user `/` command needed.

---

## Built-in Skills

| Slash command | Description | User-only? |
|---|---|---|
| `/commit` | Draft and create a git commit for staged changes | Yes |
| `/gh-issue` | Create, view, list, comment on GitHub issues | No |
| `/gh-pr` | Open, review, check CI, merge GitHub PRs | No |
| `/branch` | Create a feature branch tied to a GitHub issue | No |
| `/review` | Review code for correctness, style, and security | No |
| `/debug` | Diagnose and fix a reported error | No |
| `/run-tests` | Detect test framework, run suite, surface failures | No |
| `/typecheck` | Run type checker and report errors by file | No |
| `/lint` | Run linter, auto-fix what's fixable, report the rest | No |
| `/explain` | Explain code or a concept | No |
| `/test` | Write tests for a function or module | No |

---

## Writing a Custom Skill

1. Create the directory:
   ```bash
   mkdir -p .opencli/skills/my-skill
   ```

2. Write `SKILL.md`:
   ```markdown
   ---
   name: my-skill
   description: Does X when the user asks to X.
   allowed-tools: Bash Read
   ---

   Context about this project:
   !{cat README.md | head -20 2>/dev/null || echo ""}

   Task: $ARGUMENTS

   Steps:
   1. ...
   ```

3. Restart the session — `discover()` runs at startup.

4. Invoke with `/my-skill <args>` or let the model call `activate_skill("my-skill")` automatically.

---

## Updating Docs When Skills Change

When adding, removing, or renaming a built-in skill:

- **`docs/skills.md`** — update the Built-in Skills table
- **`docs/architecture.md`** — update the built-in skills list and the `src/skills/builtin/` file tree
- **`CLAUDE.md` and `AGENTS.md`** — update the `builtin/` comment in the Source Structure section (keep both files in sync)
