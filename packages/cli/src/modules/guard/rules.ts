import { basename } from 'node:path';
import { findSecrets } from '@yandecode/core';

export interface GuardInput {
  tool: string;
  input: Record<string, unknown>;
}

export interface GuardOptions {
  root: string;
  /** Rule ids turned off in yandecode.json → guard.disabled. */
  disabled: readonly string[];
}

export interface Verdict {
  decision: 'deny' | 'warn' | 'allow';
  rule: string;
  reason?: string;
  /** Present when a deny was overridden with `# guard-ok: <reason>`. */
  overridden?: string;
}

interface Rule {
  id: string;
  decision: 'deny' | 'warn';
  /** Returns a reason when the rule fires. */
  check: (call: ParsedCall) => string | null;
}

interface ParsedCall {
  tool: string;
  /** Raw command (Bash) — used for secret detection. */
  command: string;
  /** Command with quoted text blanked and split into simple commands. */
  segments: string[];
  filePath: string | null;
  content: string;
}

const OVERRIDE = /(?:#\s*|\[)guard-ok:\s*([^\]\n]+?)\s*\]?\s*$/m;
const OVERRIDE_HINT =
  'If the user explicitly asked for this, re-run it with `# guard-ok: <reason>` appended to the command.';

const CREDENTIAL_FILE =
  /^(\.env(\..+)?|id_(rsa|dsa|ecdsa|ed25519)|.+\.(pem|key|p12|pfx|keystore)|\.netrc|\.git-credentials|\.pgpass|credentials(\.json)?)$/;
const CREDENTIAL_TEMPLATE = /\.(example|sample|template|dist|defaults)$/;
const READERS = /^(cat|less|more|head|tail|bat|xxd|strings|od|nl|source|\.)\b/;

function isCredentialFile(path: string): boolean {
  const name = basename(path);
  return CREDENTIAL_FILE.test(name) && !CREDENTIAL_TEMPLATE.test(name);
}

function parse(call: GuardInput): ParsedCall {
  const command = typeof call.input.command === 'string' ? call.input.command : '';
  const bare = command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, (quoted) =>
    /^"\$\{?HOME\}?"$/.test(quoted) ? '$HOME' : "''",
  );
  const filePath =
    typeof call.input.file_path === 'string'
      ? call.input.file_path
      : typeof call.input.notebook_path === 'string'
        ? call.input.notebook_path
        : null;
  const content = ['content', 'new_string', 'new_source']
    .map((k) => call.input[k])
    .filter((v): v is string => typeof v === 'string')
    .join('\n');
  const segments = bare
    .replace(/#.*$/gm, '')
    .split(/&&|\|\||;|\||\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return { tool: call.tool, command, segments, filePath, content };
}

const anySegment = (call: ParsedCall, test: (segment: string) => boolean): boolean =>
  call.tool === 'Bash' && call.segments.some(test);

const RM_RECURSIVE_FORCE =
  /^rm\s+(-\w*r\w*f\w*|-\w*f\w*r\w*|(-\w+\s+)*--recursive\s+--force|-r\s+-f|-f\s+-r)\b/;
const RM_CRITICAL_TARGET = /\s(\/|\/\*|~|~\/|~\/\*|\$HOME|\$HOME\/\*?|\.|\.\.|\*)\s*$/;

const RULES: readonly Rule[] = [
  {
    id: 'secrets-in-command',
    decision: 'deny',
    check: (call) => {
      if (call.tool !== 'Bash') return null;
      const hits = findSecrets(call.command);
      return hits.length > 0
        ? `The command contains a credential (${hits.map((h) => `${h.rule} ${h.preview}`).join(', ')}); it would be stored in the transcript and shell history. Read it from an environment variable instead.`
        : null;
    },
  },
  {
    id: 'secrets-in-content',
    decision: 'deny',
    check: (call) => {
      if (!call.content) return null;
      const hits = findSecrets(call.content);
      return hits.length > 0
        ? `The new content contains a credential (${hits.map((h) => `${h.rule} ${h.preview}`).join(', ')}). Load it from the environment or a secret manager instead of writing it to ${call.filePath ?? 'a file'}.`
        : null;
    },
  },
  {
    id: 'credential-file',
    decision: 'deny',
    check: (call) => {
      if (call.tool === 'Read' && call.filePath && isCredentialFile(call.filePath)) {
        return `${basename(call.filePath)} holds credentials; reading it copies them into the conversation. Ask the user for the specific non-secret value you need, or read the template (e.g. .env.example).`;
      }
      const reader = call.segments.find(
        (s) => READERS.test(s) && s.split(/\s+/).slice(1).some(isCredentialFile),
      );
      return reader ? `\`${reader}\` would print credentials into the conversation.` : null;
    },
  },
  {
    id: 'sudo',
    decision: 'deny',
    check: (call) =>
      anySegment(call, (s) => /^(sudo|doas)\b/.test(s))
        ? 'Privilege escalation from the agent is blocked. Ask the user to run it themselves (they can type `! <command>`).'
        : null,
  },
  {
    id: 'destructive-rm',
    decision: 'deny',
    check: (call) =>
      anySegment(call, (s) => RM_RECURSIVE_FORCE.test(s) && RM_CRITICAL_TARGET.test(s))
        ? 'Recursive forced delete of the filesystem root, the home directory or the whole working directory.'
        : null,
  },
  {
    id: 'disk',
    decision: 'deny',
    check: (call) =>
      anySegment(call, (s) => /^mkfs(\.\w+)?\b|^dd\b.*\bof=\/dev\/|>\s*\/dev\/(sd|nvme|hd)/.test(s))
        ? 'Writes directly to a block device or formats a filesystem.'
        : null,
  },
  {
    id: 'force-push',
    decision: 'deny',
    check: (call) =>
      anySegment(
        call,
        (s) =>
          /^git\s+push\b/.test(s) &&
          /\s(--force(?!-with-lease)|-f)\b/.test(s) &&
          /\b(main|master)\b|\s\+/.test(s),
      )
        ? 'Force-pushing to main/master rewrites shared history.'
        : null,
  },
  {
    id: 'force-push',
    decision: 'warn',
    check: (call) =>
      anySegment(call, (s) => /^git\s+push\b/.test(s) && /\s(--force(?!-with-lease)|-f)\b/.test(s))
        ? 'Force push without --force-with-lease can overwrite collaborators’ commits; prefer --force-with-lease.'
        : null,
  },
  {
    id: 'history-rewrite',
    decision: 'warn',
    check: (call) =>
      anySegment(call, (s) =>
        /^git\s+(reset\s+--hard|clean\s+-\w*f|checkout\s+--\s+\.|restore\s+\.)/.test(s),
      )
        ? 'This discards uncommitted work irreversibly; make sure the user wants that (git stash keeps a copy).'
        : null,
  },
  {
    id: 'credential-file',
    decision: 'warn',
    check: (call) =>
      (call.tool === 'Edit' || call.tool === 'Write' || call.tool === 'MultiEdit') &&
      call.filePath &&
      isCredentialFile(call.filePath)
        ? `Editing ${basename(call.filePath)}, a credentials file: do not echo its values back into the conversation.`
        : null,
  },
];

/**
 * Deterministic verdict for one tool call (ADR-022): the first deny wins, else the first warn,
 * else null. A deny can be overridden by the agent with `# guard-ok: <reason>` (logged).
 */
export function evaluate(call: GuardInput, options: GuardOptions): Verdict | null {
  const parsed = parse(call);
  const active = RULES.filter((r) => !options.disabled.includes(r.id));
  for (const decision of ['deny', 'warn'] as const) {
    for (const rule of active.filter((r) => r.decision === decision)) {
      const reason = rule.check(parsed);
      if (reason === null) continue;
      const override = OVERRIDE.exec(parsed.command)?.[1];
      if (decision === 'deny' && override)
        return { decision: 'allow', rule: rule.id, overridden: override };
      return {
        decision,
        rule: rule.id,
        reason: decision === 'deny' ? `${reason} ${OVERRIDE_HINT}` : reason,
      };
    }
  }
  return null;
}
