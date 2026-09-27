import { describe, expect, it, vi } from 'vitest';
import {
  adjudicate,
  resolveEnforced,
  type AdjudicatorSettings,
} from '@cli/modules/guard/adjudicator';
import type { Verdict } from '@cli/modules/guard/rules';

const settings: AdjudicatorSettings = {
  mode: 'enforce',
  model: 'typesafe/jev-1.13',
  baseUrl: 'https://openrouter.ai/api/alpha',
  denyConfidence: 0.8,
  timeoutMs: 8000,
};
const warn: Verdict = { decision: 'warn', rule: 'history-rewrite', reason: 'discards work' };
const call = { tool: 'Bash', command: 'git reset --hard', filePath: null, cwd: '/repo' };
const answer = (choice: string, confidence: number): Response =>
  ({
    ok: true,
    json: () => Promise.resolve({ answers: { verdict: { type: 'choice', choice, confidence } } }),
  }) as Response;

describe('resolveEnforced', () => {
  it('honours a deny only at or above the confidence floor', () => {
    expect(resolveEnforced({ decision: 'deny', confidence: 0.9 }, 0.8)).toBe('deny');
    expect(resolveEnforced({ decision: 'deny', confidence: 0.7 }, 0.8)).toBe('warn');
  });

  it('clears the warning on allow and keeps it otherwise, including fail-open (null)', () => {
    expect(resolveEnforced({ decision: 'allow', confidence: 0.9 }, 0.8)).toBe('allow');
    expect(resolveEnforced({ decision: 'warn', confidence: 0.9 }, 0.8)).toBe('warn');
    expect(resolveEnforced(null, 0.8)).toBe('warn');
  });
});

describe('adjudicate', () => {
  it('returns Jev’s typed verdict and never sends file contents in the state', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(answer('deny', 0.95));
    const verdict = await adjudicate(call, warn, settings, 'sk-test', fetchImpl as typeof fetch);
    expect(verdict).toEqual({ decision: 'deny', confidence: 0.95 });
    const body = JSON.parse((fetchImpl.mock.calls[0]![1] as { body: string }).body) as {
      state: string;
      questions: { verdict: { criteria: Record<string, string> } };
    };
    expect(body.state).toContain('git reset --hard');
    expect(body.state).not.toContain('content');
    expect(Object.keys(body.questions.verdict.criteria).sort()).toEqual(['allow', 'deny', 'warn']);
  });

  it('rejects a choice outside the offered criteria', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(answer('maybe', 0.9));
    expect(await adjudicate(call, warn, settings, 'k', fetchImpl as typeof fetch)).toBeNull();
  });

  it('fails open (null) on a non-ok response or a thrown error', async () => {
    const notOk = vi.fn().mockResolvedValue({ ok: false });
    expect(await adjudicate(call, warn, settings, 'k', notOk as typeof fetch)).toBeNull();
    const threw = vi.fn().mockRejectedValue(new Error('network'));
    expect(await adjudicate(call, warn, settings, 'k', threw as typeof fetch)).toBeNull();
  });
});
