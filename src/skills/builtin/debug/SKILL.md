---
name: debug
description: Diagnose and fix a reported error or unexpected behaviour. Use when asked to debug or fix an error.
allowed-tools: Read Grep Glob Bash
---

Debug the following issue: $ARGUMENTS

Process:
1. Read the error message and stack trace carefully
2. Locate the relevant source files
3. Identify the root cause (don't just treat symptoms)
4. Propose and apply a minimal targeted fix
5. Explain what caused the bug and why the fix resolves it

Avoid adding error-handling wrappers that hide the root cause.
