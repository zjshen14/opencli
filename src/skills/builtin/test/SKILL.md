---
name: test
description: Write tests for a function, module, or feature. Use when asked to write or add tests.
allowed-tools: Read Glob Grep Write
---

Write tests for: $ARGUMENTS

Steps:
1. Read the target code to understand inputs, outputs, and edge cases
2. Check the existing test files for patterns and test framework in use
3. Write tests covering:
   - Happy path (expected inputs → expected outputs)
   - Edge cases (empty, null, boundary values)
   - Error cases (invalid inputs, failure modes)
4. Place tests in the appropriate test file following existing conventions

Keep tests focused and independent. Do not test implementation details.
