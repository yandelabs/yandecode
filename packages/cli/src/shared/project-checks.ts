import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const STEPS = ['format', 'typecheck', 'lint', 'test'] as const;
export type Step = (typeof STEPS)[number];

export interface Check {
  step: Step;
  command: string;
}

const SCRIPT_CANDIDATES: Readonly<Record<Step, readonly string[]>> = {
  format: ['format:check', 'fmt:check'],
  typecheck: ['typecheck', 'type-check', 'tsc', 'check-types'],
  lint: ['lint'],
  test: ['test'],
};

function packageManager(root: string): string {
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(root, 'bun.lockb')) || existsSync(join(root, 'bun.lock'))) return 'bun';
  return 'npm';
}

function nodeChecks(root: string): Check[] {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const scripts = pkg.scripts ?? {};
  const pm = packageManager(root);
  return STEPS.flatMap((step) => {
    const name = SCRIPT_CANDIDATES[step].find((candidate) => candidate in scripts);
    return name ? [{ step, command: `${pm} run ${name}` }] : [];
  });
}

function pythonChecks(root: string): Check[] {
  const pyproject = existsSync(join(root, 'pyproject.toml'))
    ? readFileSync(join(root, 'pyproject.toml'), 'utf8')
    : '';
  const checks: Check[] = [];
  if (pyproject.includes('[tool.mypy]')) checks.push({ step: 'typecheck', command: 'mypy .' });
  if (pyproject.includes('[tool.ruff')) checks.push({ step: 'lint', command: 'ruff check .' });
  if (pyproject.includes('[tool.pytest') || existsSync(join(root, 'pytest.ini')))
    checks.push({ step: 'test', command: 'pytest -q' });
  return checks;
}

/**
 * The project's own verification commands, in a sensible order. Explicit overrides from
 * yandecode.json (quality.commands) replace detection entirely.
 */
export function detectChecks(root: string, overrides: Partial<Record<Step, string>> = {}): Check[] {
  const explicit = STEPS.flatMap((step) =>
    overrides[step] ? [{ step, command: overrides[step] }] : [],
  );
  if (explicit.length > 0) return explicit;
  if (existsSync(join(root, 'package.json'))) return nodeChecks(root);
  if (existsSync(join(root, 'go.mod'))) {
    return [
      { step: 'lint', command: 'go vet ./...' },
      { step: 'test', command: 'go test ./...' },
    ];
  }
  if (existsSync(join(root, 'Cargo.toml'))) {
    return [
      { step: 'lint', command: 'cargo clippy --quiet' },
      { step: 'test', command: 'cargo test --quiet' },
    ];
  }
  return pythonChecks(root);
}
