import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  YandeCodeError,
  loadConfig,
  resolveWorkspace,
  type WorkspacePaths,
  type YandeCodeConfig,
} from '@yandecode/core';
import type { ZodType } from 'zod';
import type { ModuleContext, ModuleDefinition } from './contract';
import { MODULES } from './registry';
import { resolveEnabled } from './resolve';

export interface Workspace {
  root: string;
  paths: WorkspacePaths;
  config: YandeCodeConfig;
}

export function openWorkspace(cwd: string): Workspace | null {
  const paths = resolveWorkspace(cwd);
  if (!paths) return null;
  return { root: paths.root, paths, config: loadConfig(paths.root) };
}

export function requireWorkspace(cwd: string): Workspace {
  const ws = openWorkspace(cwd);
  if (!ws) {
    throw new YandeCodeError(
      'WORKSPACE_NOT_INITIALIZED',
      `no yandecode.json found above ${cwd}; run "yandecode init"`,
    );
  }
  return ws;
}

export function findModule(
  id: string,
  registry: readonly ModuleDefinition[] = MODULES,
): ModuleDefinition {
  const module = registry.find((m) => m.id === id);
  if (!module) {
    throw new YandeCodeError(
      'MODULE_UNKNOWN',
      `unknown module "${id}" (available: ${registry.map((m) => m.id).join(', ')})`,
    );
  }
  return module;
}

/** Enabled module definitions in dependency order (dependencies are implicitly enabled). */
export function enabledModules(
  ws: Workspace,
  registry: readonly ModuleDefinition[] = MODULES,
): ModuleDefinition[] {
  return resolveEnabled(registry, ws.config.modules).map((id) => findModule(id, registry));
}

export function moduleContext(ws: Workspace, module: ModuleDefinition): ModuleContext {
  const raw = ws.config[module.id];
  return {
    root: ws.root,
    paths: ws.paths,
    config: ws.config,
    settings: typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {},
    log: (event, data) => {
      try {
        mkdirSync(ws.paths.logsDir, { recursive: true });
        appendFileSync(
          join(ws.paths.logsDir, `${module.id}.jsonl`),
          `${JSON.stringify({ at: new Date().toISOString(), event, ...data })}\n`,
        );
      } catch {
        // Logging must never break a hook or tool call.
      }
    },
  };
}

/** Parses a module's yandecode.json section, reporting problems with the full field path. */
export function parseSettings<T>(moduleId: string, schema: ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new YandeCodeError(
      'CONFIG_INVALID',
      `yandecode.json ${moduleId}: ${parsed.error.issues
        .map((i) => `${[moduleId, ...i.path].join('.')}: ${i.message}`)
        .join('; ')}`,
    );
  }
  return parsed.data;
}
