---
name: yandecode-tdd
description: Test-driven development — write a failing test for the behaviour, watch it fail for the right reason, write the minimum code, watch it pass, refactor. Use when implementing any feature or bug fix before writing production code.
---

# Test-driven development

**No production code without a failing test that demands it.**

## Cycle

1. **Red** — write one test for the next behaviour (or the bug's reproduction). Run it (`ctx_run("<test command> <file>", intent="failure reason")`). It must fail, and fail _because the behaviour is missing_ — not from a typo, import error or wrong fixture. If it passes, the test is wrong or the behaviour already exists.
2. **Green** — write the simplest code that makes it pass. No extra options, no speculative generality.
3. **Run everything relevant** — the new test and the suite around it. All green.
4. **Refactor** — remove duplication, improve names, keep behaviour. Re-run.
5. Next behaviour.

## Good tests

- Test behaviour through public interfaces, not private helpers or call counts.
- One behaviour per test; the name states it ("rejects an expired token").
- Cover the failure cases the acceptance criteria name, not only the happy path.
- Real code over mocks; mock only true boundaries (network, clock, randomness) and keep the mock faithful.
- Deterministic: no sleeps, fixed clocks, isolated temp directories.

## Bugs

Reproduce the bug as a failing test first (see `yandecode-debugging` for finding the root cause). The fix is done when that test passes and the suite is green.

## When you catch yourself

- wrote code before the test → keep it aside, write the test, watch it fail against the old code, then bring the code back;
- a test passed on the first run → make it fail deliberately once to prove it can;
- "too simple to test" → the test takes a minute; write it.

---

Adapted from obra/superpowers `test-driven-development` (MIT); see NOTICE.md in the yandecode content directory.
