import type { HookInput, HookResult, ModuleContext, ModuleRuntime } from '@cli/modules/contract';
import { parseSettings } from '@cli/modules/host';
import { adjudicate, resolveEnforced, type AdjudicatorSettings } from './adjudicator';
import { secretsInPendingCommit } from './commit-scan';
import { guardSettings } from './definition';
import { evaluate, type Verdict } from './rules';

const COMMIT = /(^|[;&|]\s*)git\s+(-C\s+\S+\s+)?commit\b/m;

function commitVerdict(
  command: string,
  cwd: string,
  disabled: readonly string[],
): HookResult | null {
  if (disabled.includes('commit-secrets') || !COMMIT.test(command)) return null;
  const all = /\scommit\b[^;&|]*\s(-a|--all|-\w*a\w*)\b/.test(command);
  const found = secretsInPendingCommit(cwd, all, 800);
  if (found.length === 0) return null;
  return {
    kind: 'deny',
    reason: `The commit would record credentials: ${found.join('; ')}. Remove them from the change (and rotate them if they were ever pushed). If they are test fixtures the user approved, re-run with \`# guard-ok: <reason>\`.`,
  };
}

const warnContext = (verdict: Verdict, note = ''): HookResult => ({
  kind: 'context',
  text: `yandecode guard (${verdict.rule}): ${verdict.reason!}${note}`,
});

/**
 * A warn verdict is where Jev earns its keep. Off (or no API key) keeps the plain caution; shadow
 * asks Jev and logs its opinion but never changes the outcome; enforce acts on a confident deny or
 * a clear allow. Any Jev failure falls back to the caution (fail-open).
 */
async function resolveWarn(
  verdict: Verdict,
  call: { tool: string; command: string; filePath: string | null; cwd: string },
  adj: AdjudicatorSettings,
  ctx: ModuleContext,
): Promise<HookResult> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (adj.mode === 'off' || !apiKey) return warnContext(verdict);
  const opinion = await adjudicate(call, verdict, adj, apiKey);
  ctx.log('adjudicated', {
    rule: verdict.rule,
    tool: call.tool,
    mode: adj.mode,
    decision: opinion?.decision ?? 'unavailable',
    confidence: opinion?.confidence,
  });
  if (adj.mode === 'shadow') return warnContext(verdict);
  const enforced = resolveEnforced(opinion, adj.denyConfidence);
  if (enforced === 'deny')
    return {
      kind: 'deny',
      reason: `${verdict.reason!} Jev judged this too risky (confidence ${opinion!.confidence.toFixed(2)}). If you meant to do this, re-run with \`# guard-ok: <reason>\`.`,
    };
  if (enforced === 'allow') return { kind: 'none' };
  return warnContext(verdict);
}

/** Scans a `git commit` for staged secrets (only when no rule already overrode the call). */
function commitDeny(
  input: HookInput,
  verdict: Verdict | null,
  command: string,
  cwd: string,
  disabled: readonly string[],
  ctx: ModuleContext,
): HookResult | null {
  if (input.tool_name !== 'Bash' || verdict?.overridden !== undefined) return null;
  const commit = commitVerdict(command, cwd, disabled);
  if (!commit) return null;
  ctx.log('deny', { rule: 'commit-secrets' });
  return commit;
}

async function preToolUse(input: HookInput, ctx: ModuleContext): Promise<HookResult> {
  const { disabled, adjudicator } = parseSettings('guard', guardSettings, ctx.settings);
  const toolInput = input.tool_input ?? {};
  const verdict = evaluate(
    { tool: input.tool_name ?? '', input: toolInput },
    { root: ctx.root, disabled },
  );
  if (verdict)
    ctx.log(verdict.decision, {
      rule: verdict.rule,
      tool: input.tool_name,
      overridden: verdict.overridden,
    });
  if (verdict?.decision === 'deny') return { kind: 'deny', reason: verdict.reason! };
  const command = typeof toolInput.command === 'string' ? toolInput.command : '';
  const cwd = typeof input.cwd === 'string' ? input.cwd : ctx.root;
  const commit = commitDeny(input, verdict, command, cwd, disabled, ctx);
  if (commit) return commit;
  if (verdict?.decision === 'warn') {
    const filePath = typeof toolInput.file_path === 'string' ? toolInput.file_path : null;
    const call = { tool: input.tool_name ?? '', command, filePath, cwd };
    return resolveWarn(verdict, call, adjudicator, ctx);
  }
  return { kind: 'none' };
}

export const runtime: ModuleRuntime = {
  hooks: { PreToolUse: preToolUse },
};
