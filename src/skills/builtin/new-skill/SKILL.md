---
name: new-skill
description: Scaffold a new custom SKILL.md file interactively. Use when asked to create a new skill or slash command.
allowed-tools: Write
disable-agent-invocation: true
---

Create a new custom skill for this project.

What to build: $ARGUMENTS

## Steps

1. **Gather requirements** — If `$ARGUMENTS` is empty, ask the user:
   - What should the skill do?
   - What slash command name should invoke it (short, kebab-case, e.g. `deploy`, `summarise-pr`)?
   - Should only the user be able to invoke it, or can the model also self-activate it?

2. **Design the skill**:
   - **name**: short kebab-case identifier matching the slash command
   - **description**: one precise, verb-led sentence (e.g. "Run …", "Generate …", "Analyse …") — the model uses this for auto-activation, so specificity matters
   - **allowed-tools**: space-separated, limited to what the skill genuinely needs (`Read`, `Write`, `Edit`, `Glob`, `Grep`, `Bash`)
   - **disable-agent-invocation**: set `true` for side-effectful or destructive skills (deploy, commit, send messages); omit for general-purpose skills
   - **Body**: numbered step-by-step instructions the model follows; reference `$ARGUMENTS` for the user-supplied target
   - **Preprocessors**: add `!{cmd || echo "fallback"}` only when useful context should be captured at activation time (e.g. current git branch, project config); always include a fallback

3. **Show the complete draft SKILL.md** to the user and ask for approval or edits before writing anything.

4. **Write the file** to `.opencli/skills/<name>/SKILL.md` using the `write` tool — it will prompt for confirmation before touching the filesystem.

5. **Confirm success**:
   - Report the exact path written
   - Remind the user the skill is discoverable after restarting the session (invoke with `/<name> [args]`)

## SKILL.md format reference

```yaml
---
name: <kebab-case-name>
description: <one sentence — verb-led, specific enough for auto-activation>
allowed-tools: <space-separated: Read Write Edit Glob Grep Bash>
# disable-agent-invocation: true   # uncomment for user-only or dangerous skills
---

<Step-by-step instructions. Use $ARGUMENTS for the user's input.>
<Optional: !{cmd || echo "fallback"} for context injected at activation time.>
```

Skills land in `.opencli/skills/<name>/SKILL.md` (project-scoped, highest priority).
They override same-named built-ins and are discovered at the next session start.
