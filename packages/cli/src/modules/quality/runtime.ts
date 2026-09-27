import { mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { openModuleDb, type Database } from '@yandecode/core';
import { z } from 'zod';
import type {
  HookInput,
  HookResult,
  ModuleContext,
  ModuleRuntime,
  ToolResult,
} from '@cli/modules/contract';
import { parseSettings } from '@cli/modules/host';
import { digest } from '@cli/shared/digest';
import { execShell } from '@cli/shared/exec';
import { detectChecks } from '@cli/shared/project-checks';
import { checkInput, qualitySettings } from './definition';
import { scanEdit } from './patterns';

const PER_FAILURE_CHARS = 1_500;
const MIGRATIONS = [
  'CREATE TABLE warned (session_id TEXT NOT NULL, path TEXT NOT NULL, rule TEXT NOT NULL, PRIMARY KEY (session_id, path, rule));',
];
const dbs = new Map<string, Database>();

function dbFor(ctx: ModuleContext): Database {
  let db = dbs.get(ctx.root);
  if (!db) {
    mkdirSync(ctx.paths.yandecodeDir, { recursive: true });
    db = openModuleDb(join(ctx.paths.yandecodeDir, 'quality.db'), MIGRATIONS);
    dbs.set(ctx.root, db);
  }
  return db;
}

async function qualityCheck(raw: Record<string, unknown>, ctx: ModuleContext): Promise<ToolResult> {
  const args = z.object(checkInput).parse(raw);
  const settings = parseSettings('quality', qualitySettings, ctx.settings);
  const checks = detectChecks(ctx.root, settings.commands).filter(
    (c) => !args.steps || args.steps.includes(c.step),
  );
  if (checks.length === 0) {
    return {
      text: 'quality_check: no checks found. Add scripts (typecheck/lint/test) to package.json or set yandecode.json quality.commands, e.g. {"test": "make test"}.',
    };
  }
  const lines: string[] = [];
  let failed = 0;
  for (const check of checks) {
    const result = await execShell(check.command, {
      cwd: ctx.root,
      timeoutMs: (args.timeout_s ?? 600) * 1000,
      maxBytes: 20 * 1_048_576,
    });
    const seconds = (result.durationMs / 1000).toFixed(1);
    if (result.exitCode === 0 && !result.timedOut) {
      lines.push(`✓ ${check.step} (${check.command}) ${seconds} s`);
      continue;
    }
    failed++;
    const why = result.timedOut ? 'timed out' : `exit ${result.exitCode ?? 'signal'}`;
    lines.push(`✗ ${check.step} (${check.command}) ${why}, ${seconds} s`);
    lines.push(
      digest(result.output.trimEnd(), { maxChars: PER_FAILURE_CHARS }).text.replace(/^/gm, '    '),
    );
  }
  return {
    text: [`quality_check: ${checks.length - failed} passed, ${failed} failed`, ...lines].join(
      '\n',
    ),
  };
}

function onEdit(input: HookInput, ctx: ModuleContext): Promise<HookResult> {
  const settings = parseSettings('quality', qualitySettings, ctx.settings);
  const toolInput = input.tool_input ?? {};
  const path = toolInput.file_path ?? toolInput.notebook_path;
  if (!settings.editWarnings || typeof path !== 'string') return Promise.resolve({ kind: 'none' });
  const edits = Array.isArray(toolInput.edits)
    ? (toolInput.edits as { new_string?: unknown }[])
    : [];
  const content = [
    toolInput.content,
    toolInput.new_string,
    toolInput.new_source,
    ...edits.map((e) => e.new_string),
  ]
    .filter((v): v is string => typeof v === 'string')
    .join('\n');
  const rel = relative(ctx.root, path) || path;
  const insert = dbFor(ctx).prepare(
    'INSERT OR IGNORE INTO warned (session_id, path, rule) VALUES (?, ?, ?)',
  );
  const fresh = scanEdit(rel, content).filter(
    (f) => insert.run(input.session_id ?? 'unknown', rel, f.rule).changes === 1,
  );
  if (fresh.length === 0) return Promise.resolve({ kind: 'none' });
  ctx.log('edit_warning', { path: rel, rules: fresh.map((f) => f.rule) });
  return Promise.resolve({
    kind: 'context',
    text: [
      `yandecode quality — review ${rel}:`,
      ...fresh.map((f) => `- ${f.rule}: ${f.advice}`),
    ].join('\n'),
  });
}

export const runtime: ModuleRuntime = {
  tools: { quality_check: qualityCheck },
  hooks: { PostToolUse: onEdit },
  doctor: (ctx) => {
    const settings = parseSettings('quality', qualitySettings, ctx.settings);
    const checks = detectChecks(ctx.root, settings.commands);
    return Promise.resolve([
      checks.length > 0
        ? {
            name: 'checks',
            status: 'ok',
            detail: checks.map((c) => `${c.step}: ${c.command}`).join('; '),
          }
        : {
            name: 'checks',
            status: 'warn',
            detail: 'none detected',
            fix: 'set quality.commands in yandecode.json',
          },
    ]);
  },
  dispose: () => {
    for (const db of dbs.values()) db.close();
    dbs.clear();
    return Promise.resolve();
  },
};
