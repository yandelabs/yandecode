# Development

```bash
npm install
npm run check        # typecheck + eslint (strictTypeChecked) + prettier --check + vitest
npm run build        # esbuild bundle → packages/cli/dist (bin + lazy chunks + content)
npm run bench        # benchmarks (build first; hook latency uses the bundle)
node scripts/verify-install.mjs   # pack + clean-prefix install + init/doctor/MCP/uninstall
node scripts/e2e-claude.mjs       # two real Claude Code sessions (costs a few cents)
node examples/demo/demo.mjs       # modules working together, no model needed
```

Every commit must pass `npm run check`.

## Conventions

- TypeScript with `moduleResolution: Bundler`: imports have no extension. Across packages import only `@yandecode/core` / `@yandecode/retrieval`; inside a package use its alias (`@core/…`, `@retrieval/…`, `@cli/…`) or `./sibling` — never `../`. ESLint enforces both.
- `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, complexity ≤ 15 per function. When the linter objects, change the design (extract a named step, use a lookup table) rather than silencing it.
- Tool handlers parse their input with `z.object(<shape exported by definition.ts>)`; no casts from `Record<string, unknown>`.
- Errors that reach users carry a code and say what to do (`YandeCodeError('CONFIG_INVALID', 'yandecode.json code.maxChars: …')`).
- Tests are behaviour-first and use real code: temp directories, real SQLite, real child processes, the fixture repository, a fake LSP server speaking the real protocol, and the real typescript-language-server when npm is reachable.

## Test-driven changes

1. Write the test that states the behaviour and its failure cases; run it and watch it fail for the right reason.
2. Implement the minimum; run the file, then `npm run check`.
3. Refactor with the suite green.

## Adding a module

1. `packages/cli/src/modules/<id>/definition.ts` — export the zod input shapes and a `ModuleDefinition` (`tools`, `hooks`, `skills`, `agents`, `guidance`, `requirements`, `load: async () => (await import('./runtime')).runtime`). Keep it light: no heavy imports.
2. `runtime.ts` — handlers, `doctor`, `dispose`; open state lazily with `openModuleDb(join(ctx.paths.yandecodeDir, '<id>.db'), MIGRATIONS)`; read settings with `parseSettings('<id>', schema, ctx.settings)`.
3. Skills/agents go in `packages/content/{skills,agents}`.
4. Add the definition to `modules/registry.ts`. The contract test checks handlers and content files; add behaviour tests for the runtime.
5. Document it in `docs/modules.md`, and write an ADR if it makes a decision others depend on.

## Releasing

Bump `packages/cli/package.json` (and the root) version, `npm run check && npm run build && node scripts/verify-install.mjs`, then `npm publish` from `packages/cli`.
