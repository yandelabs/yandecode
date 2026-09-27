export interface SecretHit {
  rule: string;
  /** First and last 4 characters only — safe to log or show. */
  preview: string;
}

interface SecretRule {
  rule: string;
  pattern: RegExp;
  /** Capture group holding the secret itself (default: whole match). */
  group?: number;
}

/** High-confidence token formats; generic entropy scans produce too many false positives. */
const RULES: readonly SecretRule[] = [
  { rule: 'aws-access-key', pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  {
    rule: 'github-token',
    pattern: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/g,
  },
  { rule: 'anthropic-key', pattern: /\bsk-ant-[A-Za-z0-9_-]{32,}/g },
  { rule: 'openai-key', pattern: /\bsk-(proj-)?[A-Za-z0-9_-]{32,}/g },
  { rule: 'slack-token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}/g },
  { rule: 'stripe-key', pattern: /\b(sk|rk)_live_[A-Za-z0-9]{20,}/g },
  { rule: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { rule: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  {
    rule: 'url-credentials',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/${}]{6,})@/gi,
    group: 1,
  },
];

const PLACEHOLDER = /EXAMPLE|PLACEHOLDER|REDACTED|YOUR[_-]|xxxx|\*\*\*\*|\.\.\./i;

function preview(secret: string): string {
  return secret.length <= 10 ? '…' : `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}

/** Secrets found in `text` (placeholders and env-var references are ignored). */
export function findSecrets(text: string): SecretHit[] {
  const hits: SecretHit[] = [];
  for (const { rule, pattern, group } of RULES) {
    for (const match of text.matchAll(pattern)) {
      const secret = match[group ?? 0] ?? match[0];
      if (PLACEHOLDER.test(match[0])) continue;
      hits.push({ rule, preview: preview(secret) });
    }
  }
  return hits;
}
