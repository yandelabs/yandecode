# ADR-024: Workflows are skills plus persistent change folders; swarm is removed

Status: accepted (2026-09-26). Supersedes ADR-010 and ADR-012; replaces spec-v1 D3/D4 swarm work.

## Context

The v0 swarm (DAG scheduler, leases, worktrees) had documented hang scenarios and was never used for real work (G8). Superpowers shows workflow value comes from disciplined skills; OpenSpec shows resumable work needs physical artifacts, not conversation.

## Decision

The `workflow` module ships skills adapted from Superpowers (MIT, attributed): brainstorming, writing specs/plans, TDD, systematic debugging, verification-before-completion, subagent-driven execution. Work state lives in `docs/changes/<id>/` (`proposal.md`, `design.md`, `tasks.md` with stable task ids and checkboxes, `specs/`), OpenSpec-compatible in shape. MCP tools: `work_new`, `work_status` (stage derived from files present and checkbox state), `work_next` (next unchecked task with its acceptance criteria) and `work_check(task_id)`. Subagents use Claude Code's native Agent tool; no scheduler.

The `swarm` package, its MCP tools, agents and skills are deleted, with its tables left in place (migrations are append-only).

## Consequences

Any interrupted session resumes from `work_status`/`work_next`. There is no bespoke orchestration state that can hang.
