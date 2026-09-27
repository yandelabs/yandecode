import { YandeCodeError } from '@yandecode/core';
import type { ModuleDefinition } from './contract';

/**
 * Expands the requested module ids with their transitive dependencies and returns them in an
 * order where every module comes after the modules it requires (ties keep registry order).
 */
export function resolveEnabled(
  registry: readonly ModuleDefinition[],
  requested: readonly string[],
): string[] {
  const byId = new Map(registry.map((m) => [m.id, m]));
  const wanted = new Set<string>();
  const visit = (id: string, trail: string[]): void => {
    if (trail.includes(id)) {
      throw new YandeCodeError('MODULE_CYCLE', `dependency cycle: ${[...trail, id].join(' -> ')}`);
    }
    const module = byId.get(id);
    if (!module) {
      const valid = registry.map((m) => m.id).join(', ');
      throw new YandeCodeError('MODULE_UNKNOWN', `unknown module "${id}" (available: ${valid})`);
    }
    if (wanted.has(id)) return;
    for (const dep of module.requires) visit(dep, [...trail, id]);
    wanted.add(id);
  };
  for (const id of requested) visit(id, []);

  const ordered: string[] = [];
  const place = (id: string): void => {
    if (ordered.includes(id)) return;
    for (const dep of byId.get(id)!.requires) place(dep);
    ordered.push(id);
  };
  for (const module of registry) if (wanted.has(module.id)) place(module.id);
  return ordered;
}

/** Enabled modules that directly or transitively require `id` (they block disabling it). */
export function dependentsOf(
  registry: readonly ModuleDefinition[],
  enabled: readonly string[],
  id: string,
): string[] {
  const byId = new Map(registry.map((m) => [m.id, m]));
  const needs = (candidate: string, seen = new Set<string>()): boolean => {
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    const requires = byId.get(candidate)?.requires ?? [];
    return requires.includes(id) || requires.some((dep) => needs(dep, seen));
  };
  return enabled.filter((candidate) => candidate !== id && needs(candidate));
}
