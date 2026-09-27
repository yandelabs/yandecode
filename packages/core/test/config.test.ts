import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CONFIG_FILENAME,
  CONFIG_VERSION,
  loadConfig,
  migrateConfig,
  writeConfig,
  writeDefaultConfig,
} from '@core/config/load';
import { YandeCodeError } from '@core/errors';

const tmp = (): string => mkdtempSync(join(tmpdir(), 'yc-config-'));
const write = (root: string, value: unknown): void => {
  writeFileSync(join(root, CONFIG_FILENAME), JSON.stringify(value));
};

describe('loadConfig', () => {
  it('returns an empty v2 config when yandecode.json is missing', () => {
    expect(loadConfig(tmp())).toEqual({ version: CONFIG_VERSION, modules: [] });
  });

  it('returns a fresh object per call (no shared singleton aliasing)', () => {
    const root = tmp();
    expect(loadConfig(root)).not.toBe(loadConfig(root));
  });

  it('keeps per-module sections untouched for the modules to validate', () => {
    const root = tmp();
    write(root, { version: 2, modules: ['code'], code: { maxResults: 5 } });
    const cfg = loadConfig(root);
    expect(cfg.modules).toEqual(['code']);
    expect(cfg.code).toEqual({ maxResults: 5 });
  });

  it('rejects a non-array modules field with the field path', () => {
    const root = tmp();
    write(root, { version: 2, modules: 'code' });
    expect(() => loadConfig(root)).toThrow(YandeCodeError);
    expect(() => loadConfig(root)).toThrow(/CONFIG_INVALID.*modules/);
  });

  it('rejects a config written by a newer yandecode', () => {
    const root = tmp();
    write(root, { version: 99, modules: [] });
    expect(() => loadConfig(root)).toThrow(/CONFIG_INVALID.*newer/);
  });

  it('rejects malformed JSON with CONFIG_INVALID', () => {
    const root = tmp();
    writeFileSync(join(root, CONFIG_FILENAME), '{ not json');
    expect(() => loadConfig(root)).toThrow(/CONFIG_INVALID/);
  });

  it('migrates a v0 config in memory without rewriting the file', () => {
    const root = tmp();
    const v0 = { swarm: { maxAgents: 2 }, rag: { enabled: true }, memory: { enabled: true } };
    write(root, v0);
    expect(loadConfig(root)).toEqual({ version: 2, modules: ['code', 'knowledge'] });
    expect(JSON.parse(readFileSync(join(root, CONFIG_FILENAME), 'utf8'))).toEqual(v0);
  });
});

describe('migrateConfig', () => {
  it('maps disabled v0 features to absent modules and drops swarm', () => {
    expect(
      migrateConfig({ rag: { enabled: false }, memory: { enabled: true }, swarm: {} }),
    ).toEqual({ version: 2, modules: ['knowledge'] });
  });

  it('treats an empty v0 object as all v0 defaults (rag + memory on)', () => {
    expect(migrateConfig({})).toEqual({ version: 2, modules: ['code', 'knowledge'] });
  });

  it('leaves a v2 config as is', () => {
    const v2 = { version: 2, modules: ['guard'], guard: { budgetMs: 500 } };
    expect(migrateConfig(v2)).toEqual(v2);
  });
});

describe('writeConfig / writeDefaultConfig', () => {
  it('writeConfig round-trips through loadConfig', () => {
    const root = tmp();
    writeConfig(root, { version: 2, modules: ['code', 'context'] });
    expect(loadConfig(root).modules).toEqual(['code', 'context']);
  });

  it('writeDefaultConfig creates the file once and never overwrites', () => {
    const root = tmp();
    expect(writeDefaultConfig(root, ['code'])).toBe(true);
    write(root, { version: 2, modules: ['guard'] });
    expect(writeDefaultConfig(root, ['code'])).toBe(false);
    expect(loadConfig(root).modules).toEqual(['guard']);
  });
});
