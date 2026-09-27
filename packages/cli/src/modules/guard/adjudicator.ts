// Optional Jev adjudicator for the guard's ambiguous (warn) cases, mirroring jev-kit's airlock:
// deterministic rules run first and only the genuinely ambiguous calls are sent to Jev — the real
// TypeSafe typed-decision model, which returns a calibrated choice among allow/warn/deny. Fail-open
// throughout: a null answer leaves the deterministic verdict untouched.
import { decideChoice, type JevCall } from '@cli/shared/jev';
import type { Verdict } from './rules';

export type AdjudicatorMode = 'off' | 'shadow' | 'enforce';

export interface AdjudicatorSettings extends JevCall {
  mode: AdjudicatorMode;
  /** A deny is honoured only at or above this confidence (jev-kit uses 0.8). */
  denyConfidence: number;
}

export interface AdjCall {
  tool: string;
  /** Bash command, when the call is a shell command. */
  command?: string;
  /** File path only — never the file's contents, which may hold secrets. */
  filePath?: string | null;
  cwd: string;
}

export interface AdjVerdict {
  decision: 'allow' | 'warn' | 'deny';
  confidence: number;
}

const CRITERIA: Record<AdjVerdict['decision'], string> = {
  allow: 'The call is safe in this context; let it run silently.',
  warn: 'Let it run but surface a caution to the agent; there is some risk.',
  deny: 'Block it: real, avoidable risk to the repository or to credentials.',
};

/** The situation described to Jev — deliberately no file contents. */
function state(call: AdjCall, ruleVerdict: Verdict): string {
  return JSON.stringify({
    tool: call.tool,
    command: call.command,
    file: call.filePath ?? undefined,
    cwd: call.cwd,
    flagged_rule: ruleVerdict.rule,
    rule_reason: ruleVerdict.reason,
  });
}

/**
 * Ask Jev to judge one ambiguous call. Returns its typed verdict, or null on any failure so the
 * caller keeps the deterministic verdict (fail-open). Never throws.
 */
export async function adjudicate(
  call: AdjCall,
  ruleVerdict: Verdict,
  settings: AdjudicatorSettings,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AdjVerdict | null> {
  const answer = await decideChoice(
    settings,
    state(call, ruleVerdict),
    'A deterministic rule flagged this coding-agent tool call as ambiguous. Decide what to do.',
    CRITERIA,
    apiKey,
    fetchImpl,
  );
  return answer
    ? { decision: answer.choice as AdjVerdict['decision'], confidence: answer.confidence }
    : null;
}

/**
 * Fold Jev's verdict into the deterministic warn verdict under `enforce`: a confident deny blocks,
 * an allow clears the warning, anything else (including a null/fail-open result) keeps the warn.
 */
export function resolveEnforced(
  adj: AdjVerdict | null,
  denyConfidence: number,
): 'deny' | 'warn' | 'allow' {
  if (adj === null) return 'warn';
  if (adj.decision === 'deny' && adj.confidence >= denyConfidence) return 'deny';
  if (adj.decision === 'allow') return 'allow';
  return 'warn';
}
