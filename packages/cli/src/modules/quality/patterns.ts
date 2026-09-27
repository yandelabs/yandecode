import { extname } from 'node:path';

export interface Finding {
  rule: string;
  advice: string;
}

interface Pattern {
  rule: string;
  /** File extensions (lowercase, with dot) or a path test. */
  applies: (path: string) => boolean;
  pattern: RegExp;
  advice: string;
}

const ext =
  (...exts: string[]) =>
  (path: string): boolean =>
    exts.includes(extname(path).toLowerCase());
const JS = ext('.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts', '.vue', '.svelte');
const PY = ext('.py', '.pyi');
const CODE = (path: string): boolean =>
  JS(path) || PY(path) || ext('.rb', '.php', '.go', '.java', '.kt', '.rs')(path);

/**
 * Risky constructs worth a second look right after an edit (ADR-023). Only new content is
 * scanned, and each hit is advice for the agent, not a block.
 */
const PATTERNS: readonly Pattern[] = [
  {
    rule: 'actions-injection',
    applies: (p) => /(^|\/)\.github\/workflows\/.+\.ya?ml$/.test(p),
    pattern:
      /run:.*\$\{\{\s*github\.event\.(issue|pull_request|comment|review|review_comment|head_commit|commits|pages)\./,
    advice:
      'untrusted GitHub event data interpolated into a run: step allows command injection; pass it through env: and quote "$VAR"',
  },
  {
    rule: 'eval',
    applies: CODE,
    pattern: /(^|[^\w.])(eval|new Function)\s*\(/,
    advice: 'dynamic code evaluation executes whatever the input contains; parse the data instead',
  },
  {
    rule: 'shell-injection',
    applies: CODE,
    pattern:
      /\b(exec|execSync)\s*\(\s*`[^`]*\$\{|shell\s*=\s*True|os\.system\s*\(\s*f?["']|child_process.*\bshell:\s*true/,
    advice:
      'building a shell command from variables allows injection; use execFile/spawn with an argument array (subprocess.run([...]) in Python)',
  },
  {
    rule: 'html-injection',
    applies: JS,
    pattern: /\.innerHTML\s*=|\.outerHTML\s*=|dangerouslySetInnerHTML|document\.write\s*\(/,
    advice: 'raw HTML insertion enables XSS; render text, or sanitize with a vetted library first',
  },
  {
    rule: 'sql-injection',
    applies: CODE,
    pattern:
      /`\s*(SELECT|INSERT|UPDATE|DELETE)\b[^`]*\$\{|["'](SELECT|INSERT|UPDATE|DELETE)\b[^"']*["']\s*(\+|%|\.format\()/i,
    advice:
      'SQL built by string concatenation/interpolation is injectable; use parameters/placeholders',
  },
  {
    rule: 'unsafe-deserialization',
    applies: PY,
    pattern:
      /pickle\.loads?\s*\(|yaml\.unsafe_load\s*\(|yaml\.load\s*\((?![^)]*SafeLoader)|torch\.load\s*\((?![^)]*weights_only\s*=\s*True)/,
    advice:
      'this deserializer can execute arbitrary code from its input; use json / yaml.safe_load / weights_only=True',
  },
  {
    rule: 'tls-disabled',
    applies: CODE,
    pattern:
      /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['"]?0|verify\s*=\s*False|InsecureSkipVerify\s*:\s*true/,
    advice:
      'certificate verification is disabled, allowing man-in-the-middle attacks; configure the CA instead',
  },
  {
    rule: 'weak-hash',
    applies: CODE,
    pattern: /createHash\(\s*['"](md5|sha1)['"]\s*\)|hashlib\.(md5|sha1)\s*\(/,
    advice: 'MD5/SHA-1 are broken for security use; use SHA-256+ (or scrypt/argon2 for passwords)',
  },
];

export function scanEdit(path: string, content: string): Finding[] {
  const posix = path.replace(/\\/g, '/');
  return PATTERNS.filter((p) => p.applies(posix) && p.pattern.test(content)).map((p) => ({
    rule: p.rule,
    advice: p.advice,
  }));
}
