import type { ModuleRuntime } from '@cli/modules/contract';
import { requireWorkspace } from '@cli/modules/host';
import { auditInstructions, type InstructionsReport } from './audit';

function formatReport(report: InstructionsReport): string {
  const files =
    report.files.length > 0
      ? report.files.map((f) => `  ${f.path} (~${f.approxTokens} tokens)`)
      : ['  (none)'];
  const issues =
    report.issues.length > 0
      ? report.issues.map(
          (i) => `  ${i.file}${i.line > 0 ? `:${i.line}` : ''} ${i.kind}: ${i.detail}`,
        )
      : ['  none'];
  return [
    'instruction files:',
    ...files,
    `issues (${report.issues.length}):`,
    ...issues,
    'detected conventions (state the non-obvious ones in CLAUDE.md):',
    ...report.conventions.map((c) => `  ${c}`),
  ].join('\n');
}

export const runtime: ModuleRuntime = {
  tools: {
    instructions_audit: (_args, ctx) =>
      Promise.resolve({ text: formatReport(auditInstructions(ctx.root)) }),
  },
  doctor: (ctx) => {
    const report = auditInstructions(ctx.root);
    return Promise.resolve([
      report.issues.length === 0
        ? {
            name: 'instructions',
            status: 'ok',
            detail: `${report.files.length} file(s), no issues`,
          }
        : {
            name: 'instructions',
            status: 'warn',
            detail: `${report.issues.length} issue(s)`,
            fix: 'yandecode instructions audit',
          },
    ]);
  },
};

export function runAuditCommand(cwd: string): number {
  const report = auditInstructions(requireWorkspace(cwd).root);
  process.stdout.write(`${formatReport(report)}\n`);
  return report.issues.length > 0 ? 1 : 0;
}
