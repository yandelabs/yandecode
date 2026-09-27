import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveInsideRoot, userCacheDir } from '@yandecode/core';
import { extractSymbols, supportsSymbols, detectLanguage } from '@yandecode/retrieval';
import { z } from 'zod';
import type { ModuleContext, ModuleRuntime, ToolResult } from '@cli/modules/contract';
import { parseSettings } from '@cli/modules/host';
import { fitRows } from '@cli/shared/budget';
import { definitionInput, diagnosticsInput, lspSettings, referencesInput } from './definition';
import { installServer, resolveServer, serverForPath, SERVERS, type ServerSpec } from './servers';
import { LspSession } from './session';

const cacheDir = (): string => join(userCacheDir(), 'lsp');
const sessions = new Map<string, Promise<LspSession>>();

async function sessionFor(ctx: ModuleContext, path: string): Promise<LspSession> {
  const spec = serverForPath(path);
  if (!spec) {
    throw new Error(
      `no language server configured for ${path} (supported: ${Object.values(SERVERS)
        .flatMap((s) => s.extensions)
        .join(' ')})`,
    );
  }
  const key = `${ctx.root}\0${spec.id}`;
  let session = sessions.get(key);
  if (!session) {
    session = (async () => {
      const { autoInstall } = parseSettings('lsp', lspSettings, ctx.settings);
      let server = resolveServer(ctx.root, spec, cacheDir());
      if (!server && autoInstall) {
        ctx.log('install', { server: spec.id });
        server = await installServer(spec, cacheDir()).catch((error: unknown) => {
          throw new Error(
            `could not install ${spec.packages.join(' ')} (${(error as Error).message}); install it manually or run "yandecode lsp install ${spec.id}" with network access`,
          );
        });
      }
      if (!server) throw new Error(`${spec.bin} not found; run "yandecode lsp install ${spec.id}"`);
      return LspSession.start({
        root: ctx.root,
        command: server.command,
        args: server.args,
        languageIdFor: spec.languageIdFor,
      });
    })();
    sessions.set(key, session);
    session.catch(() => sessions.delete(key));
  }
  return session;
}

function relativePath(ctx: ModuleContext, path: string): string {
  resolveInsideRoot(ctx.root, path);
  return path.replace(/^\.\//, '');
}

/** 0-based position of a symbol's name on its declaration line. */
async function symbolPosition(
  ctx: ModuleContext,
  path: string,
  namePath: string,
): Promise<{ line: number; character: number }> {
  const language = detectLanguage(path);
  if (!supportsSymbols(language))
    throw new Error(`cannot locate symbols in ${path}; pass line and column`);
  const text = readFileSync(join(ctx.root, path), 'utf8');
  const symbols = await extractSymbols(text, language!);
  const symbol =
    symbols.find((s) => s.namePath === namePath) ??
    symbols.find((s) => s.namePath.endsWith(`/${namePath}`) || s.name === namePath);
  if (!symbol) throw new Error(`no symbol "${namePath}" in ${path}`);
  const lineText = text.split('\n')[symbol.startLine - 1] ?? '';
  const character =
    new RegExp(`\\b${symbol.name.replace(/[$]/g, '\\$')}\\b`).exec(lineText)?.index ?? 0;
  return { line: symbol.startLine - 1, character };
}

function lineOf(ctx: ModuleContext, path: string, line: number): string {
  try {
    return (readFileSync(join(ctx.root, path), 'utf8').split('\n')[line - 1] ?? '')
      .trim()
      .slice(0, 160);
  } catch {
    return '';
  }
}

async function lspReferences(
  raw: Record<string, unknown>,
  ctx: ModuleContext,
): Promise<ToolResult> {
  const args = z.object(referencesInput).parse(raw);
  const path = relativePath(ctx, args.path);
  const position = args.name_path
    ? await symbolPosition(ctx, path, args.name_path)
    : args.line && args.column
      ? { line: args.line - 1, character: args.column - 1 }
      : null;
  if (!position) return { isError: true, text: 'pass name_path, or line and column' };
  const refs = await (
    await sessionFor(ctx, path)
  ).references(path, position.line, position.character);
  const rows = refs.map((r) => `${r.path}:${r.line}:${r.column} ${lineOf(ctx, r.path, r.line)}`);
  return {
    text: fitRows(`${refs.length} reference(s) (language server)`, rows, args.max_chars ?? 4_000),
  };
}

async function lspDefinition(
  raw: Record<string, unknown>,
  ctx: ModuleContext,
): Promise<ToolResult> {
  const args = z.object(definitionInput).parse(raw);
  const path = relativePath(ctx, args.path);
  const found = await (
    await sessionFor(ctx, path)
  ).definition(path, args.line - 1, args.column - 1);
  if (found.length === 0)
    return { text: `No definition found at ${path}:${args.line}:${args.column}.` };
  return {
    text: found
      .map((d) => `${d.path}:${d.line}:${d.column} ${lineOf(ctx, d.path, d.line)}`)
      .join('\n'),
  };
}

async function lspDiagnostics(
  raw: Record<string, unknown>,
  ctx: ModuleContext,
): Promise<ToolResult> {
  const args = z.object(diagnosticsInput).parse(raw);
  const path = relativePath(ctx, args.path);
  const items = await (await sessionFor(ctx, path)).diagnostics(path);
  if (items.length === 0) return { text: `${path}: no problems reported.` };
  const rows = items.map(
    (d) =>
      `${path}:${d.line}:${d.column} ${d.severity} ${d.message.split('\n')[0]}${d.source ? ` (${d.source})` : ''}`,
  );
  const errors = items.filter((d) => d.severity === 'error').length;
  return {
    text: fitRows(
      `${path}: ${errors} error(s), ${items.length - errors} other`,
      rows,
      args.max_chars ?? 4_000,
    ),
  };
}

export const runtime: ModuleRuntime = {
  tools: {
    lsp_references: lspReferences,
    lsp_definition: lspDefinition,
    lsp_diagnostics: lspDiagnostics,
  },
  doctor: (ctx) =>
    Promise.resolve(
      Object.values(SERVERS).map((spec: ServerSpec) => {
        const server = resolveServer(ctx.root, spec, cacheDir());
        return server
          ? { name: spec.id, status: 'ok' as const, detail: `${server.source}: ${server.command}` }
          : {
              name: spec.id,
              status: 'warn' as const,
              detail: 'not installed (installed on first use)',
              fix: `yandecode lsp install ${spec.id}`,
            };
      }),
    ),
  dispose: async () => {
    const all = [...sessions.values()];
    sessions.clear();
    await Promise.allSettled(all.map(async (s) => (await s).shutdown()));
  },
};

function isLanguage(value: string): value is keyof typeof SERVERS {
  return Object.hasOwn(SERVERS, value);
}

export async function runInstallCommand(language?: string): Promise<number> {
  if (language !== undefined && !isLanguage(language)) {
    process.stderr.write(
      `unknown language "${language}" (available: ${Object.keys(SERVERS).join(', ')})\n`,
    );
    return 1;
  }
  const specs: ServerSpec[] = language ? [SERVERS[language]] : Object.values(SERVERS);
  for (const spec of specs) {
    process.stdout.write(`installing ${spec.packages.join(' ')} …\n`);
    const server = await installServer(spec, cacheDir());
    process.stdout.write(`  ${spec.id}: ${server.command}\n`);
  }
  return 0;
}
