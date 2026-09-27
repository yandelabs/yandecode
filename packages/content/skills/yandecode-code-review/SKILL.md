---
name: yandecode-code-review
description: Review a change (working tree, branch or PR) for real bugs and project-rule violations with a confidence filter. Use when asked to review code, before claiming a non-trivial change is done, or before opening a pull request.
---

# Code review

Goal: few findings, each real and actionable. A review that lists ten maybes is worse than one that lists two certain bugs.

## 1. Scope the change

- Default scope: `git diff` (unstaged) plus `git diff --cached`; for a branch, `git diff $(git merge-base HEAD main)...HEAD`; for a PR, `gh pr diff <n>`.
- List changed files and read the project rules that apply to them: root `CLAUDE.md`/`AGENTS.md` and any in the changed directories.
- Run `quality_check` first. Do not report what the compiler, linter or tests already report — fix or mention the failing step instead.

## 2. Review in parallel

Dispatch the `yandecode-reviewer` agent (bugs + project rules) and, when the change touches input handling, auth, crypto, files, processes, SQL, HTML or CI, the `yandecode-security-reviewer` agent. Give each the exact diff scope and the rule files. Reviewers use `code_definition` / `code_references` to check callers instead of reading whole files.

## 3. Score and filter

Each finding gets a confidence score:

| score  | meaning                                                                |
| ------ | ---------------------------------------------------------------------- |
| 0–25   | probably a false positive or pre-existing                              |
| 26–50  | nitpick not required by the project rules                              |
| 51–79  | real but minor, or unverified                                          |
| 80–100 | verified bug, security issue or explicit rule violation that will bite |

Report only findings scoring **≥ 80**. Before reporting, re-read the code path once more to confirm.

Not findings: pre-existing issues, style a formatter owns, things silenced on purpose (lint-ignore comments), speculative performance, "consider adding tests" unless the rules require them.

## 4. Report

For each finding: `path:line` — what breaks, when, and the smallest fix. Group by severity. If nothing survives the filter, say so plainly ("no issues at ≥ 80 confidence") and list what was checked.
