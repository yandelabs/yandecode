# ADR-023: Review and security as a quality module (deterministic checks + reviewer agents)

Status: accepted (2026-09-26)

## Context

code-review (official) runs parallel specialized agents and keeps only findings scoring ≥ 80/100 confidence; security-guidance warns on risky patterns right after edits.

## Decision

The `quality` module ships:

- `PostToolUse` on edits: deterministic security pattern warnings (own pattern table: GitHub Actions injection, `eval`/`new Function`, `child_process.exec` with interpolation, `innerHTML`/`dangerouslySetInnerHTML`, `pickle`/`yaml.load`, SQL string concatenation, hardcoded secrets), deduplicated per file+rule per session.
- `quality_check()` MCP tool: detects and runs the project's own typecheck/lint/test commands through the context store (ADR-019 if enabled), returning pass/fail and failing excerpts.
- Skills `yandecode-code-review` and `yandecode-security-review` plus agents `yandecode-reviewer` and `yandecode-security-reviewer`: review the diff in parallel, score confidence, report only ≥ 80.

## Alternatives considered

- Stop-hook LLM review on every turn (security-guidance): costs tokens on every turn. Rejected as default.

## Consequences

Deterministic checks run always; model-based review runs only when asked or when a workflow reaches its review step.
