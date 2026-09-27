import { existsSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import {
  ensureWorkspaceDirs,
  resolveInsideRoot,
  sha256,
  workspacePathsFor,
  writeFileAtomic,
} from '@yandecode/core';
import { contentRoot } from '@cli/content';
import { launcherCommandLine, type Launcher } from '@cli/launcher';
import type { HookEvent, ModuleDefinition } from '@cli/modules/contract';
import { routingSkill } from '@cli/modules/routing';
import { VERSION } from '@cli/version';
import { claudeMdBlock, removeBlock, upsertBlock } from './claude-md';
import { ensureGitignoreEntry } from './gitignore';
import { readJsonSafe } from './json-utils';
import { readManifest, writeManifest, type ManagedFile } from './manifest';
import { materializeFile, type MaterializeResult } from './materialize';
import { addMcpServer, removeMcpServer } from './mcp-config';
import { mergeHooks, removeHooks, removeStatusLine } from './settings';

const HOOK_TIMEOUT_SECONDS: Partial<Record<HookEvent, number>> = { PreToolUse: 5, PostToolUse: 5 };

export interface ApplyOptions {
  root: string;
  modules: readonly ModuleDefinition[];
  launcher: Launcher;
  /** Overwrite managed files even when the user edited them. */
  force?: boolean;
  /** Source of skills/agents (defaults to the bundled content directory). */
  contentRoot?: string;
}

export interface ApplyReport {
  files: (MaterializeResult & { module: string })[];
  /** Managed files of modules no longer enabled, removed because they were unmodified. */
  removed: string[];
  /** Files of disabled modules left in place because the user edited them. */
  keptEdited: string[];
  settingsUpdated: boolean;
  mcpUpdated: boolean;
  claudeMdUpdated: boolean;
  gitignoreUpdated: boolean;
}

interface DesiredFile {
  path: string;
  content: string;
  module: string;
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...filesUnder(abs));
    else out.push(abs);
  }
  return out;
}

function desiredFiles(modules: readonly ModuleDefinition[], sourceDir: string): DesiredFile[] {
  const out: DesiredFile[] = [];
  // Generated from the enabled modules, so it never names a tool that is not installed.
  if (modules.some((m) => (m.routing ?? []).length > 0)) {
    out.push({
      path: '.claude/skills/yandecode-tool-routing/SKILL.md',
      content: routingSkill(modules),
      module: 'core',
    });
  }
  for (const module of modules) {
    for (const skill of module.skills) {
      const dir = join(sourceDir, 'skills', skill);
      for (const abs of filesUnder(dir)) {
        const rel = relative(dir, abs).split(sep).join('/');
        out.push({
          path: `.claude/skills/${skill}/${rel}`,
          content: readFileSync(abs, 'utf8'),
          module: module.id,
        });
      }
    }
    for (const agent of module.agents) {
      out.push({
        path: `.claude/agents/${agent}.md`,
        content: readFileSync(join(sourceDir, 'agents', `${agent}.md`), 'utf8'),
        module: module.id,
      });
    }
  }
  return out;
}

/** One settings group per event; the dispatcher filters by each module's own matcher. */
export function hookGroupsFor(
  modules: readonly ModuleDefinition[],
  launcher: Launcher,
): Record<string, unknown[]> {
  // `null` = some module wants every tool of this event, so no matcher is written.
  const byEvent = new Map<HookEvent, Set<string> | null>();
  for (const { event, matcher } of modules.flatMap((m) => m.hooks)) {
    const current = byEvent.get(event);
    if (current === null) continue;
    byEvent.set(event, matcher ? new Set([...(current ?? []), ...matcher.split('|')]) : null);
  }
  const out: Record<string, unknown[]> = {};
  for (const [event, matchers] of byEvent) {
    const hook = {
      type: 'command',
      command: launcherCommandLine(launcher, 'hook', event),
      timeout: HOOK_TIMEOUT_SECONDS[event] ?? 10,
    };
    out[event] = [
      matchers === null
        ? { hooks: [hook] }
        : { matcher: [...matchers].sort().join('|'), hooks: [hook] },
    ];
  }
  return out;
}

function readText(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

/** Writes `next` unless the file already holds it; never creates a file just to make it empty. */
function writeIfChanged(file: string, next: string, emptyValue = ''): boolean {
  if (!existsSync(file) && next === emptyValue) return false;
  if (readText(file) === next) return false;
  writeFileAtomic(file, next);
  return true;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

function removeEmptyDirsUpTo(dir: string, stopAt: string): void {
  let current = dir;
  while (current.startsWith(stopAt) && current !== stopAt) {
    if (!existsSync(current) || readdirSync(current).length > 0) return;
    rmSync(current, { recursive: true });
    current = dirname(current);
  }
}

/** Deletes managed files that are no longer wanted, unless the user edited them. */
function removeUnwanted(
  root: string,
  previous: readonly ManagedFile[],
  wanted: ReadonlySet<string>,
): { removed: string[]; keptEdited: string[] } {
  const removed: string[] = [];
  const keptEdited: string[] = [];
  for (const old of previous.filter((f) => !wanted.has(f.path))) {
    const abs = resolveInsideRoot(root, old.path);
    if (!existsSync(abs)) continue;
    if (sha256(readFileSync(abs)) !== old.hash) {
      keptEdited.push(old.path);
      continue;
    }
    unlinkSync(abs);
    removed.push(old.path);
    removeEmptyDirsUpTo(dirname(abs), join(root, '.claude'));
  }
  return { removed, keptEdited };
}

function applySettings(
  root: string,
  modules: readonly ModuleDefinition[],
  launcher: Launcher,
): boolean {
  const file = join(root, '.claude', 'settings.json');
  // Also drops v0 leftovers: yandecode hook groups and the yandecode status line.
  const base = removeStatusLine(removeHooks(readJsonSafe<Record<string, unknown>>(file, {})));
  const groups = hookGroupsFor(modules, launcher);
  const next = Object.keys(groups).length > 0 ? mergeHooks(base, groups) : base;
  return writeIfChanged(file, json(next), json({}));
}

function applyMcp(root: string, modules: readonly ModuleDefinition[], launcher: Launcher): boolean {
  const file = join(root, '.mcp.json');
  const current = readJsonSafe<Record<string, unknown>>(file, {});
  const hasTools = modules.some((m) => (m.tools ?? []).length > 0);
  const next = hasTools ? addMcpServer(current, launcher) : removeMcpServer(current);
  return writeIfChanged(file, json(next), json({ mcpServers: {} }));
}

function applyClaudeMd(root: string, modules: readonly ModuleDefinition[]): boolean {
  const file = join(root, 'CLAUDE.md');
  const current = readText(file);
  const guidance = modules.flatMap((m) => (m.guidance ? [m.guidance] : []));
  const next =
    guidance.length > 0 ? upsertBlock(current, claudeMdBlock(guidance)) : removeBlock(current);
  return writeIfChanged(file, next);
}

function applyGitignore(root: string): boolean {
  const file = join(root, '.gitignore');
  return writeIfChanged(file, ensureGitignoreEntry(readText(file), '.yandecode/'));
}

/** Manifest entries for materialized files; a preserved user edit keeps the previous hash. */
function manifestEntries(
  files: readonly (MaterializeResult & { module: string })[],
  previous: ReadonlyMap<string, ManagedFile>,
): ManagedFile[] {
  return files.flatMap((f) => {
    if (f.action !== 'preserved') return [{ path: f.path, hash: f.hash, module: f.module }];
    // The user's own content hash must never be recorded as managed content (ADR-015).
    const prev = previous.get(f.path);
    return prev ? [{ path: f.path, hash: prev.hash, module: f.module }] : [];
  });
}

/**
 * Reconciles the project's Claude Code integration with the enabled modules: skills, agents,
 * hooks, MCP registration and the CLAUDE.md block. Files the user edited are never overwritten
 * (unless forced) nor deleted; everything written is recorded in the managed manifest (ADR-015).
 */
export function applyIntegration(options: ApplyOptions): ApplyReport {
  const { root, modules, launcher } = options;
  const paths = workspacePathsFor(root);
  ensureWorkspaceDirs(paths);

  const previous = readManifest(paths.managedManifest)?.files ?? [];
  const previousByPath = new Map(previous.map((f) => [f.path, f]));
  const desired = desiredFiles(modules, options.contentRoot ?? contentRoot());
  const { removed, keptEdited } = removeUnwanted(
    root,
    previous,
    new Set(desired.map((d) => d.path)),
  );
  const files = desired.map((d) => ({
    ...materializeFile(root, d.path, d.content, previousByPath.get(d.path), options.force ?? false),
    module: d.module,
  }));
  writeManifest(paths.managedManifest, {
    version: VERSION,
    files: manifestEntries(files, previousByPath),
  });

  return {
    files,
    removed,
    keptEdited,
    settingsUpdated: applySettings(root, modules, launcher),
    mcpUpdated: applyMcp(root, modules, launcher),
    claudeMdUpdated: applyClaudeMd(root, modules),
    gitignoreUpdated: applyGitignore(root),
  };
}
