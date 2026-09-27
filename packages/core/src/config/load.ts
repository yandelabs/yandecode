import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { YandeCodeError } from '@core/errors';
import { writeFileAtomic } from '@core/security/atomic-write';
import { CONFIG_FILENAME, CONFIG_VERSION, ConfigSchema, type YandeCodeConfig } from './schema';

export { CONFIG_FILENAME, CONFIG_VERSION, ConfigSchema, type YandeCodeConfig };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function featureEnabled(section: unknown): boolean {
  return !(isRecord(section) && section.enabled === false);
}

/**
 * Upgrades any known on-disk shape to v2. v0/v1 files had no `version` and fixed feature
 * sections: `rag` (code search) → module `code`, `memory` → module `knowledge`; `swarm` was
 * removed in v2 (ADR-024) and is dropped.
 */
export function migrateConfig(raw: unknown): unknown {
  if (!isRecord(raw) || 'version' in raw) return raw;
  const modules: string[] = [];
  if (featureEnabled(raw.rag)) modules.push('code');
  if (featureEnabled(raw.memory)) modules.push('knowledge');
  return { version: CONFIG_VERSION, modules };
}

export function loadConfig(projectRoot: string): YandeCodeConfig {
  const file = join(projectRoot, CONFIG_FILENAME);
  if (!existsSync(file)) return { version: CONFIG_VERSION, modules: [] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch (cause) {
    throw new YandeCodeError('CONFIG_INVALID', `${file} is not valid JSON`, { cause });
  }
  const migrated = migrateConfig(raw);
  if (
    isRecord(migrated) &&
    typeof migrated.version === 'number' &&
    migrated.version > CONFIG_VERSION
  ) {
    throw new YandeCodeError(
      'CONFIG_INVALID',
      `${file} has version ${migrated.version}, written by a newer yandecode; upgrade yandecode`,
    );
  }
  const parsed = ConfigSchema.safeParse(migrated);
  if (!parsed.success) {
    throw new YandeCodeError(
      'CONFIG_INVALID',
      `${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  return parsed.data;
}

export function writeConfig(projectRoot: string, config: YandeCodeConfig): void {
  writeFileAtomic(join(projectRoot, CONFIG_FILENAME), `${JSON.stringify(config, null, 2)}\n`);
}

export function writeDefaultConfig(projectRoot: string, modules: readonly string[]): boolean {
  if (existsSync(join(projectRoot, CONFIG_FILENAME))) return false;
  writeConfig(projectRoot, { version: CONFIG_VERSION, modules: [...modules] });
  return true;
}
