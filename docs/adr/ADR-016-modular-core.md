# ADR-016: Small core plus optional, lazily loaded modules

Status: accepted (2026-09-26)

## Context

v0 materializes everything on `yandecode init`: 7 agents, 4 skills, 6 hooks and one MCP server exposing ~17 tools, and `bin.ts` imports every command eagerly, costing ~350 ms per hook call (research G1, G3). Users must be able to pick the capabilities they want, and disabled capabilities must cost neither tokens nor processes.

## Decision

- The core owns only: config (`yandecode.json`, versioned + migrated), the module registry, workspace state (SQLite), the hook dispatcher, the MCP host, the integration materializer (settings hooks, `.mcp.json`, skills, agents, CLAUDE.md block, managed manifest) and `doctor`.
- A module is a directory exporting a `ModuleDefinition`: `id`, `summary`, `requires` (other module ids), `defaultEnabled`, `integration` (hook events + matchers, skills, agents it materializes) and `load()` — a dynamic `import()` returning the runtime part (MCP tools, hook handlers, doctor checks, CLI subcommands). The registry is a static list of definitions; the heavy code is only imported when a tool/hook of that module actually runs.
- Enabled modules live in `yandecode.json` → `modules`. `init`, `modules enable|disable` regenerate integration from the enabled set, so disabling a module removes its hooks, skills, agents and MCP tools.
- Every hook handler and module load is isolated: an exception or timeout in one module is logged and skipped (fail-open) so it never blocks Claude Code or other modules.
- Adding a module = new directory + one line in the registry. CLI commands, materializer and MCP host iterate the registry; they are not edited.

## Alternatives considered

- One Claude Code plugin per module (marketplace): real isolation, but N installs, no shared state/index, and it contradicts "install once". Rejected.
- Runtime plugin discovery from `node_modules` (third-party modules): not needed yet (YAGNI). The `ModuleDefinition` contract keeps that door open.

## Consequences

Hooks and MCP only pay for enabled modules. The managed manifest records the owning module of every materialized file so `disable`/`uninstall` stay exact (ADR-015 still holds).
