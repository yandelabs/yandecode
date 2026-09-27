# ADR-021: Dependency documentation comes from installed packages, not a remote service

Status: accepted (2026-09-26)

## Context

The goal is version-correct docs for dependencies. Context7 was removed from the references by the user. Installed packages already contain the exact version's README, type declarations and docs.

## Decision

The `libdocs` module resolves a library against the project manifests (`package.json` + `node_modules`, Python `site-packages` via `pip show -f` when available), reads its installed version and indexes README/CHANGELOG/docs and public type declarations (`.d.ts`) into the knowledge FTS corpus under namespace `lib:<name>@<version>`. Tools: `libdocs_resolve(name)` and `libdocs_query(name, query)`; results are fitted to a char budget. Reindexed when the installed version changes.

## Alternatives considered

- Context7 API: removed by the user; network, quotas.
- Crawling project websites: unversioned, slow. Rejected.

## Consequences

Works offline and always matches the version actually installed; packages without shipped docs return type signatures only, and say so.
