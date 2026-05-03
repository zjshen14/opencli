---
name: lint
description: Run the linter, auto-fix what's fixable, and report the rest. Use when asked to lint or fix lint errors.
allowed-tools: Bash
---

Lint this project.

Lint script detection:
!{cat package.json 2>/dev/null | python3 -c "import sys,json; s=json.load(sys.stdin).get('scripts',{}); print('\n'.join(f'{k}: {v}' for k,v in s.items() if 'lint' in k or 'format' in k))" 2>/dev/null || echo "(no package.json lint script found)"}

Task: $ARGUMENTS

---

Steps:
1. Detect the linter from the project manifest:
   - Node.js: `npm run lint` / `npm run lint:fix`
   - Python: `ruff check .` / `ruff check --fix .`
   - Go: `golangci-lint run`
   - Other: check Makefile or CI config
2. If the user asked to **fix**: run with the auto-fix flag first, then report what remains
3. If the user just wants a **report**: run without fixing
4. Output format: file path, line, rule name, message — grouped by file
5. Report: N issues auto-fixed, M require manual attention

Do not modify files without explicit instruction to fix.
