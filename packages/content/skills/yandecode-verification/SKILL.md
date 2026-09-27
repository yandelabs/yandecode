---
name: yandecode-verification
description: Evidence before claims — run the command that proves a claim and read its output before saying work is done, fixed, passing or ready. Use before reporting completion, checking a task, committing, or opening a PR.
---

# Verification before completion

**No completion claim without fresh evidence from this turn.**

## Gate

1. Identify the command that proves the claim (tests, typecheck, lint, build, a reproduction).
2. Run it now — `quality_check` for the project's standard checks, `ctx_run` for anything else.
3. Read the result: exit code, failure count, the failing lines.
4. Claim only what the output shows, and quote the evidence ("vitest: 214 passed, 0 failed").

| claim             | evidence required                 | not enough                    |
| ----------------- | --------------------------------- | ----------------------------- |
| tests pass        | fresh run, 0 failures             | an earlier run, "should pass" |
| bug fixed         | the reproduction now passes       | code changed                  |
| build works       | build exit 0                      | lint passing                  |
| subagent finished | its diff reviewed                 | its report                    |
| requirement met   | each acceptance criterion checked | tests green                   |

Words like "should", "probably", "looks good" before running the check mean: run the check. When `work_check` marks a task done, pass the evidence you just saw.

---

Adapted from obra/superpowers `verification-before-completion` (MIT); see NOTICE.md in the yandecode content directory.
