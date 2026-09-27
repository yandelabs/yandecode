import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModuleContext } from '@cli/modules/contract';
import { routerModule } from '@cli/modules/router/definition';
import { buildCriteria, routableOptions } from '@cli/modules/router/runtime';

const ctx = (modules: string[]): Pick<ModuleContext, 'config'> =>
  ({ config: { modules } }) as unknown as Pick<ModuleContext, 'config'>;

describe('router options', () => {
  it('collects routing rules from enabled modules and excludes itself', () => {
    const options = routableOptions(ctx(['code', 'context', 'router']));
    expect(options.length).toBeGreaterThan(0);
    expect(options.some((o) => o.use.startsWith('code_search'))).toBe(true);
    expect(options.some((o) => o.use.startsWith('ctx_run'))).toBe(true);
    // A disabled module contributes nothing.
    expect(options.some((o) => o.use.startsWith('knowledge_search'))).toBe(false);
  });

  it('keys each option and always offers a none choice', () => {
    const options = routableOptions(ctx(['code']));
    const criteria = buildCriteria(options);
    expect(Object.keys(criteria)).toContain('o0');
    expect(criteria.none).toBeDefined();
    expect(Object.keys(criteria)).toHaveLength(options.length + 1);
  });
});

describe('router hook', () => {
  let hook: NonNullable<Awaited<ReturnType<typeof routerModule.load>>['hooks']>['UserPromptSubmit'];

  const run = (prompt: string, settings: Record<string, unknown> = {}) => {
    const context = {
      root: '/repo',
      paths: {},
      config: { modules: ['code', 'context'] },
      settings,
      log: () => undefined,
    } as unknown as ModuleContext;
    return hook!({ prompt }, context);
  };

  const stubJev = (choice: string, confidence: number) =>
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({ answers: { verdict: { type: 'choice', choice, confidence } } }),
      }),
    );

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('adds a routing hint naming the tool Jev picked', async () => {
    hook = (await routerModule.load()).hooks!.UserPromptSubmit;
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test');
    stubJev('o0', 0.95);
    const result = await run('where is the JWT expiry validated in this repo?');
    expect(result.kind).toBe('context');
    expect(result.kind === 'context' && result.text).toContain('prefer `');
  });

  it('stays silent without a key, on a short prompt, on none, or on low confidence', async () => {
    hook = (await routerModule.load()).hooks!.UserPromptSubmit;
    stubJev('o0', 0.99); // no key set yet
    expect((await run('where is the JWT expiry validated?')).kind).toBe('none');
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test');
    expect((await run('thanks')).kind).toBe('none'); // chit-chat prefilter
    stubJev('none', 0.99);
    expect((await run('where is the JWT expiry validated?')).kind).toBe('none');
    stubJev('o0', 0.3);
    expect((await run('where is the JWT expiry validated?')).kind).toBe('none');
  });

  it('fails open to none when Jev errors', async () => {
    hook = (await routerModule.load()).hooks!.UserPromptSubmit;
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-test');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    expect((await run('find callers of loginWithSso across the repo')).kind).toBe('none');
  });
});
