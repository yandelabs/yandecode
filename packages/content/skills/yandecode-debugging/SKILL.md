---
name: yandecode-debugging
description: Systematic debugging — find the root cause with evidence before changing code. Use for any bug, failing test, build failure, flaky behaviour or performance regression, especially when a quick fix seems obvious or earlier fixes did not work.
---

# Systematic debugging

**No fix without a root cause.** Symptom patches create the next bug.

## 1. Investigate

- Read the whole error and stack trace; note files, lines, codes.
- Reproduce reliably. Capture noisy runs with `ctx_run(command, intent="first failure")` and read exact lines with `ctx_get`; don't re-run to scroll.
- Check what changed: `git log -n 20 --stat`, `git diff`, dependency and config changes.
- Check memory: `knowledge_search("<error or component>")` — the same failure may already be recorded.
- In multi-component paths (CI → build → deploy, API → service → DB) log what enters and leaves each boundary once, to see _where_ it breaks.
- Trace the bad value backwards (`code_references`, `code_definition`) to where it originates.

## 2. Compare

Find similar code that works; list every difference between working and broken, however small.

## 3. Hypothesis → minimal test

State one hypothesis ("X is null because Y runs before Z"). Change one thing to test it. If it is wrong, form a new hypothesis — do not stack fixes. After three failed hypotheses, stop and question the design with the user.

## 4. Fix

Write a failing test that reproduces the root cause (`yandecode-tdd`), fix at the source, run the suite. Record the root cause with `memory_write(kind: "failure", sources: [...])` when it could bite again.

---

Adapted from obra/superpowers `systematic-debugging` (MIT); see NOTICE.md in the yandecode content directory.
