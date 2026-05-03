---
name: run-tests
description: Run the project test suite and surface failures. Use when asked to run tests or check test status.
allowed-tools: Bash
---

Run the test suite for this project.

Project manifest (for test command detection):
!{cat package.json 2>/dev/null | python3 -c "import sys,json; s=json.load(sys.stdin).get('scripts',{}); print('\n'.join(f'{k}: {v}' for k,v in s.items() if 'test' in k))" 2>/dev/null || grep -E '^test' Makefile 2>/dev/null | head -5 || echo "(no manifest found)"}

Task: $ARGUMENTS

---

Steps:
1. Detect the test command from the project manifest:
   - Node.js: `npm test` or the `test` script in package.json
   - Python: `pytest` or `python -m pytest`
   - Go: `go test ./...`
   - Rust: `cargo test`
   - Other: check Makefile or CI config (`.github/workflows/`)
2. Run the test suite and capture output
3. Summarise: total passed / failed / skipped
4. For each failure: show test name, error message, and the most relevant stack frame
5. If failures are obvious to fix, suggest the fix — but do not apply it without instruction

Do not guess the test command — always read the manifest first.
