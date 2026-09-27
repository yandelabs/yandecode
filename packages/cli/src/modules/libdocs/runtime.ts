import { join } from 'node:path';
import { z } from 'zod';
import type { ModuleContext, ModuleRuntime, ToolResult } from '@cli/modules/contract';
import { fitRows } from '@cli/shared/budget';
import { queryInput, resolveInput } from './definition';
import { declaredDependencies, resolvePackage, type InstalledPackage } from './packages';
import { LibDocsStore } from './store';

const stores = new Map<string, LibDocsStore>();

function storeFor(ctx: ModuleContext): LibDocsStore {
  let store = stores.get(ctx.root);
  if (!store) {
    store = LibDocsStore.open(join(ctx.paths.yandecodeDir, 'libdocs.db'));
    stores.set(ctx.root, store);
  }
  return store;
}

function notFound(ctx: ModuleContext, name: string): ToolResult {
  const declared = declaredDependencies(ctx.root);
  const range = declared.get(name);
  if (range !== undefined) {
    return {
      isError: true,
      text: `${name} is declared in package.json (${range}) but not installed; install dependencies first (docs are read from the installed version).`,
    };
  }
  const needle = name.toLowerCase();
  const close = [...declared.keys()].filter(
    (d) => d.toLowerCase().includes(needle) || needle.includes(d.toLowerCase()),
  );
  return {
    isError: true,
    text: `No installed package "${name}".${close.length > 0 ? ` Did you mean: ${close.slice(0, 5).join(', ')}?` : ''}`,
  };
}

const label = (pkg: InstalledPackage): string =>
  `${pkg.name}@${pkg.version} (${pkg.ecosystem}${pkg.declared ? `, declared ${pkg.declared}` : ''})`;

async function libdocsResolve(
  raw: Record<string, unknown>,
  ctx: ModuleContext,
): Promise<ToolResult> {
  const { name } = z.object(resolveInput).parse(raw);
  const pkg = resolvePackage(ctx.root, name);
  if (!pkg) return notFound(ctx, name);
  const store = storeFor(ctx);
  const files = await store.ensure(pkg, ctx.root);
  const docs =
    files.length > 0
      ? `${store.sectionCount(pkg)} sections from ${files.join(', ')}`
      : 'no docs or type declarations shipped';
  return { text: `${label(pkg)}\n${docs}\nQuery with libdocs_query(name, query).` };
}

async function libdocsQuery(raw: Record<string, unknown>, ctx: ModuleContext): Promise<ToolResult> {
  const args = z.object(queryInput).parse(raw);
  const pkg = resolvePackage(ctx.root, args.name);
  if (!pkg) return notFound(ctx, args.name);
  const store = storeFor(ctx);
  await store.ensure(pkg, ctx.root);
  const sections = store.query(pkg, args.query, 6);
  if (sections.length === 0)
    return { text: `${label(pkg)}: nothing matches "${args.query}" in its shipped docs.` };
  const blocks = sections.map(
    (s) => `--- ${s.file}:${s.startLine}-${s.endLine} § ${s.heading}\n${s.content.trim()}`,
  );
  return { text: fitRows(`${label(pkg)} — "${args.query}"`, blocks, args.max_chars ?? 5_000) };
}

export const runtime: ModuleRuntime = {
  tools: { libdocs_resolve: libdocsResolve, libdocs_query: libdocsQuery },
  dispose: () => {
    for (const store of stores.values()) store.close();
    stores.clear();
    return Promise.resolve();
  },
};
