/**
 * Coarse classification of a shell command for the PreToolUse hook (ADR-019):
 * - `network`: prints a remote resource to stdout (curl/wget without an output file);
 * - `verbose`: commands whose output is routinely long (tests, builds, logs, history);
 * - `plain`: everything else.
 * Quoted text is ignored so `echo "curl …"` or `--body "run npm test"` never match.
 */
export type CommandKind = 'network' | 'verbose' | 'plain';

const VERBOSE_PATTERNS: readonly RegExp[] = [
  /^(npm|pnpm|yarn|bun) (run )?(test|build|lint|typecheck|check)\b/,
  /^npx (vitest|jest|tsc|eslint|mocha|playwright)\b/,
  /^(vitest|jest|mocha|pytest|tox|phpunit|rspec)\b/,
  /^(cargo|go) (test|build|clippy)\b/,
  /^(mvn|gradle|\.\/gradlew|make|cmake|ctest|dotnet (test|build))\b/,
  /^(docker|kubectl|podman) logs\b/,
  /^journalctl\b/,
  /^find \//,
];

function stripQuoted(command: string): string {
  return command.replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''");
}

function segments(command: string): string[] {
  return command
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim().replace(/^(sudo\s+|(\w+=\S*\s+)+)/, ''))
    .filter((s) => s.length > 0);
}

function isNetworkPrint(segment: string, redirected: boolean): boolean {
  if (/^curl\b/.test(segment)) {
    return !redirected && !/\s(-o|--output|-O|--remote-name)\b/.test(segment);
  }
  // Plain `wget URL` saves to a file; only `-O -` / `-qO-` prints to stdout.
  return /^wget\b/.test(segment) && /\s-\w*O\s*-(\s|$)/.test(`${segment} `);
}

function isUnboundedGitLog(segment: string): boolean {
  return /^git log\b/.test(segment) && !/\s(-n\s*\d+|-\d+|--max-count)/.test(segment);
}

export function classifyCommand(command: string): CommandKind {
  const bare = stripQuoted(command);
  const redirected = /[^2&]>\s*[^&\s]/.test(` ${bare}`);
  const parts = segments(bare);
  if (parts.some((s) => isNetworkPrint(s, redirected))) return 'network';
  if (parts.some((s) => VERBOSE_PATTERNS.some((p) => p.test(s)) || isUnboundedGitLog(s))) {
    return 'verbose';
  }
  return 'plain';
}
