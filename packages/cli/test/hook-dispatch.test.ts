import { describe, expect, it } from 'vitest';
import type { HookBinding, HookHandler, HookResult, ModuleDefinition } from '@cli/modules/contract';
import { CONTEXT_BUDGET_CHARS, dispatchHook, type DispatchOptions } from '@cli/hooks/dispatch';

function mod(
  id: string,
  hooks: HookBinding[],
  handlers: Partial<Record<string, HookHandler>>,
): ModuleDefinition {
  return {
    id,
    title: id,
    summary: id,
    requires: [],
    defaultEnabled: false,
    hooks,
    skills: [],
    agents: [],
    load: () => Promise.resolve({ hooks: handlers }),
  };
}

const answer =
  (result: HookResult): HookHandler =>
  () =>
    Promise.resolve(result);

function options(
  modules: ModuleDefinition[],
  extra: Partial<DispatchOptions> = {},
): DispatchOptions {
  const logged: unknown[] = [];
  return {
    event: 'PreToolUse',
    input: { tool_name: 'Bash', tool_input: { command: 'ls' } },
    modules,
    contextFor: (m) => ({
      root: '/r',
      paths: {} as never,
      config: { version: 2, modules: [] },
      settings: {},
      log: (event, data) => logged.push({ module: m.id, event, data }),
    }),
    timeoutMs: 200,
    ...extra,
  };
}

const parse = (stdout: string): Record<string, unknown> =>
  JSON.parse(stdout) as Record<string, unknown>;

describe('dispatchHook', () => {
  it('prints nothing when no module has an opinion', async () => {
    const m = mod('a', [{ event: 'PreToolUse', matcher: 'Bash' }], {
      PreToolUse: answer({ kind: 'none' }),
    });
    expect((await dispatchHook(options([m]))).stdout).toBe('');
  });

  it('skips modules whose matcher does not match the tool', async () => {
    let called = false;
    const m = mod('a', [{ event: 'PreToolUse', matcher: 'Write|Edit' }], {
      PreToolUse: () => {
        called = true;
        return Promise.resolve({ kind: 'deny', reason: 'no' });
      },
    });
    expect((await dispatchHook(options([m]))).stdout).toBe('');
    expect(called).toBe(false);
  });

  it('lets a deny win over context and joins reasons from several modules', async () => {
    const out = await dispatchHook(
      options([
        mod('ctx', [{ event: 'PreToolUse', matcher: 'Bash' }], {
          PreToolUse: answer({ kind: 'context', text: 'hint' }),
        }),
        mod('g1', [{ event: 'PreToolUse', matcher: 'Bash' }], {
          PreToolUse: answer({ kind: 'deny', reason: 'r1' }),
        }),
        mod('g2', [{ event: 'PreToolUse', matcher: 'Bash' }], {
          PreToolUse: answer({ kind: 'deny', reason: 'r2' }),
        }),
      ]),
    );
    expect(parse(out.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason: '[g1] r1\n[g2] r2',
      },
    });
  });

  it('merges context from several modules as additionalContext', async () => {
    const out = await dispatchHook(
      options(
        [
          mod('a', [{ event: 'SessionStart' }], {
            SessionStart: answer({ kind: 'context', text: 'A' }),
          }),
          mod('b', [{ event: 'SessionStart' }], {
            SessionStart: answer({ kind: 'context', text: 'B' }),
          }),
        ],
        { event: 'SessionStart', input: {} },
      ),
    );
    expect(parse(out.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'A\n\nB' },
    });
  });

  it('isolates a module that throws or times out (fail-open) and still runs the others', async () => {
    const out = await dispatchHook(
      options([
        mod('boom', [{ event: 'PreToolUse' }], {
          PreToolUse: () => Promise.reject(new Error('x')),
        }),
        mod('slow', [{ event: 'PreToolUse' }], {
          PreToolUse: () =>
            new Promise((r) =>
              setTimeout(() => {
                r({ kind: 'deny', reason: 'late' });
              }, 1000),
            ),
        }),
        mod('ok', [{ event: 'PreToolUse' }], {
          PreToolUse: answer({ kind: 'context', text: 'fine' }),
        }),
      ]),
    );
    expect(parse(out.stdout)).toEqual({
      hookSpecificOutput: { hookEventName: 'PreToolUse', additionalContext: 'fine' },
    });
    expect(out.failures.map((f) => f.module).sort()).toEqual(['boom', 'slow']);
  });

  it('keeps additionalContext within the budget, dropping whole trailing blocks', async () => {
    const big = 'x'.repeat(CONTEXT_BUDGET_CHARS - 300);
    const out = await dispatchHook(
      options(
        [
          mod('a', [{ event: 'SessionStart' }], {
            SessionStart: answer({ kind: 'context', text: big }),
          }),
          mod('b', [{ event: 'SessionStart' }], {
            SessionStart: answer({ kind: 'context', text: 'z'.repeat(400) }),
          }),
        ],
        { event: 'SessionStart', input: {} },
      ),
    );
    const text = (parse(out.stdout).hookSpecificOutput as { additionalContext: string })
      .additionalContext;
    expect(text.length).toBeLessThanOrEqual(CONTEXT_BUDGET_CHARS);
    expect(text.startsWith(big)).toBe(true);
    expect(text).toContain('[yandecode: 1 context block(s) omitted to fit the hook budget: b]');
  });

  it('truncates a single block that alone exceeds the budget instead of dropping it', async () => {
    const out = await dispatchHook(
      options(
        [
          mod('a', [{ event: 'SessionStart' }], {
            SessionStart: answer({ kind: 'context', text: 'y'.repeat(20_000) }),
          }),
        ],
        { event: 'SessionStart', input: {} },
      ),
    );
    const text = (parse(out.stdout).hookSpecificOutput as { additionalContext: string })
      .additionalContext;
    expect(text.length).toBeLessThanOrEqual(CONTEXT_BUDGET_CHARS);
    expect(text).toMatch(/\[yandecode: truncated \d+ chars from a\]$/);
  });

  it('never emits context for events that cannot carry it', async () => {
    const out = await dispatchHook(
      options(
        [
          mod('a', [{ event: 'SessionEnd' }], {
            SessionEnd: answer({ kind: 'context', text: 'x' }),
          }),
        ],
        {
          event: 'SessionEnd',
          input: {},
        },
      ),
    );
    expect(out.stdout).toBe('');
  });
});
