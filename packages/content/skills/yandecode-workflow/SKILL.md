---
name: yandecode-workflow
description: How to take non-trivial work from idea to verified change with resumable state — clarify, write a change folder (proposal/design/specs/tasks), then implement task by task with TDD and evidence. Use when asked to build a feature, change behaviour across files, or run a multi-step task that may be interrupted.
---

# Workflow: idea → verified change

State lives in files, not in the conversation: any session (or loop iteration) resumes with `work_status` and `work_next`.

## 0. Size the work

- **Question / spike** — answer it; no change folder.
- **Bounded** (one flow that already exists, a few files) — agree a short design in chat, then implement with `yandecode-tdd`. A change folder is optional.
- **Architectural** (new subsystem, interface others depend on, several steps) — full flow below.

When unsure, take the heavier path.

## 1. Understand before designing

Search first: `knowledge_search` (past decisions), `code_search` / `repo_map` (where things live). Ask the user one question at a time about purpose, constraints and success criteria; prefer multiple choice. Write back your understanding and let them correct it.

## 2. Change folder

`work_new(title, why, what)` creates `<changes>/<id>/proposal.md`. Then, as needed:

- `design.md` — context, decisions (with rejected alternatives), migration plan, risks.
- `specs/<capability>/spec.md` — requirements as `### Requirement:` with `#### Scenario:` (GIVEN/WHEN/THEN).
- `tasks.md` — the plan:

```markdown
- [ ] T1 Parse the new config field
  - AC: missing field → default 30 s
  - AC: negative value → error naming the field
  - Files: src/config/schema.ts, test/config.test.ts
- [ ] T2 …
```

Tasks are small (one commit each), ordered by dependency, with acceptance criteria a test can check. Get the user's approval on the plan before implementing architectural work.

## 3. Implement

Loop: `work_next(id)` → implement with `yandecode-tdd` → verify with `yandecode-verification` (`quality_check`) → `work_check(id, task_id, evidence)` → commit. Independent tasks may go to parallel subagents with the full task text and acceptance criteria; review their diff before checking the task.

## 4. Finish

All tasks checked → run the full `quality_check`, review with `yandecode-code-review`, record decisions worth keeping with `memory_write`, then `work_archive(id)`.

---

Adapted from obra/superpowers (MIT) and the OpenSpec change format (MIT); see NOTICE.md in the yandecode content directory.
