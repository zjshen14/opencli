---
name: review
description: Review code for correctness, style, and security issues. Use when asked to review or check code.
allowed-tools: Read Grep Glob
---

Review the following: $ARGUMENTS

Analyse for:
1. **Correctness** — logic errors, off-by-ones, unhandled edge cases
2. **Security** — injection vulnerabilities, insecure defaults, sensitive data exposure
3. **Style** — naming, readability, unnecessary complexity
4. **Performance** — obvious bottlenecks

Read the relevant files first, then provide a concise structured report. Lead with the most important issues.
