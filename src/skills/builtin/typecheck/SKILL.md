---
name: typecheck
description: Run type checking and surface errors. Use when asked to typecheck, check types, or verify types compile.
allowed-tools: Bash
---

Run type checking for this project.

Typecheck script detection:
!{cat package.json 2>/dev/null | python3 -c "import sys,json; s=json.load(sys.stdin).get('scripts',{}); print('\n'.join(f'{k}: {v}' for k,v in s.items() if any(x in k for x in ['type','tsc','check'])))" 2>/dev/null || echo "(no package.json typecheck script found)"}

Task: $ARGUMENTS

---

Steps:
1. Detect the type checker:
   - TypeScript: run the `typecheck` npm script, or `npx tsc --noEmit` if no script exists
   - Python: `mypy .` or `pyright`
   - Other: check Makefile or CI config
2. Run and capture full output
3. Group errors by file; for each: show file path, line number, error code, and message
4. Report count: N errors, M warnings
5. Prioritise errors over warnings

Do not auto-fix type errors — report them and wait for instruction.
