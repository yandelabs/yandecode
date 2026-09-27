---
name: yandecode-instructions
description: Write and maintain CLAUDE.md / AGENTS.md so they stay short, true and useful. Use when creating or editing agent instruction files, when the user corrects you about a project convention, or when instructions_audit reports issues.
---

# Project instructions

Instruction files load into every session, so each line costs tokens every time. Keep what an agent cannot discover quickly and would get wrong without being told.

## What belongs

- How to build, test, lint and run the project — exact commands (`instructions_audit` lists the detected ones).
- Non-obvious conventions and constraints ("migrations are append-only", "never import across packages except via the index").
- Where things are when the layout is surprising.
- Workflow rules the team actually enforces (branching, commit style, review).

## What does not

- Things the code or `package.json` already say, generic advice ("write clean code"), long tutorials (move them to a skill or `docs/`), history of past decisions (use `memory_write` / ADRs).

## Maintaining

1. Edit the smallest relevant file: root `CLAUDE.md` for project-wide rules, a nested `CLAUDE.md`/`AGENTS.md` for one directory.
2. When the user corrects you on a convention, add the rule in one line, with the reason if it is not obvious.
3. Run `instructions_audit`; fix missing paths, unknown commands and duplicates it reports; keep each file under ~2 000 tokens.
4. Leave the `<!-- yandecode:start -->` block alone — YandeCode regenerates it from the enabled modules.
