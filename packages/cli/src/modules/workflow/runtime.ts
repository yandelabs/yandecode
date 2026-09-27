import { existsSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { z } from 'zod';
import type { ModuleContext, ModuleRuntime, ToolResult } from '@cli/modules/contract';
import { parseSettings } from '@cli/modules/host';
import { ChangeRepository, type ChangeStatus, type Task } from './changes';
import {
  archiveInput,
  checkInput,
  newInput,
  nextInput,
  statusInput,
  workflowSettings,
} from './definition';

function repoFor(ctx: ModuleContext): ChangeRepository {
  const { changesDir } = parseSettings('workflow', workflowSettings, ctx.settings);
  const dir =
    changesDir !== undefined
      ? isAbsolute(changesDir)
        ? changesDir
        : join(ctx.root, changesDir)
      : existsSync(join(ctx.root, 'openspec', 'changes'))
        ? join(ctx.root, 'openspec', 'changes')
        : join(ctx.root, 'docs', 'changes');
  return new ChangeRepository(dir);
}

const statusLine = (s: ChangeStatus): string =>
  `${s.id} — ${s.stage}, ${s.done}/${s.total} tasks${s.next ? `; next ${s.next.id} ${s.next.title}` : ''}`;

const taskBlock = (t: Task): string =>
  [`${t.id} ${t.title}`, ...t.details.map((d) => `  ${d}`)].join('\n');

const ok = (text: string): Promise<ToolResult> => Promise.resolve({ text });

export const runtime: ModuleRuntime = {
  tools: {
    work_new: (raw, ctx) => {
      const args = z.object(newInput).parse(raw);
      const { id, dir } = repoFor(ctx).create(args);
      return ok(
        `Created change ${id} at ${relative(ctx.root, dir)}/proposal.md. Next: design.md (if needed), specs/, then tasks.md as "- [ ] T1 …" lines with indented acceptance criteria.`,
      );
    },
    work_status: (raw, ctx) => {
      const args = z.object(statusInput).parse(raw);
      const repo = repoFor(ctx);
      if (args.id) return ok(statusLine(repo.status(args.id)));
      const all = repo.list();
      return ok(
        all.length > 0
          ? all.map(statusLine).join('\n')
          : `No active changes in ${relative(ctx.root, repo.dir)}.`,
      );
    },
    work_next: (raw, ctx) => {
      const args = z.object(nextInput).parse(raw);
      const status = repoFor(ctx).status(args.id);
      if (!status.next) {
        return ok(
          status.total === 0
            ? `${args.id} has no tasks yet: write tasks.md.`
            : `${args.id}: all ${status.total} tasks done — verify and work_archive.`,
        );
      }
      return ok(`${args.id} (${status.done}/${status.total} done)\n${taskBlock(status.next)}`);
    },
    work_check: (raw, ctx) => {
      const args = z.object(checkInput).parse(raw);
      const repo = repoFor(ctx);
      const task = repo.check(args.id, args.task_id, args.evidence);
      return ok(`Checked ${task.id} ${task.title}. ${statusLine(repo.status(args.id))}`);
    },
    work_archive: (raw, ctx) => {
      const args = z.object(archiveInput).parse(raw);
      const target = repoFor(ctx).archive(args.id);
      return ok(`Archived ${args.id} → ${relative(ctx.root, target)}`);
    },
  },
  hooks: {
    SessionStart: (_input, ctx) => {
      // Only a change with work under way is news; listing every planned change was noise
      // that named unrelated tasks at the start of each session (pacolang A/B).
      const inProgress = repoFor(ctx)
        .list()
        .filter((s) => s.stage === 'in-progress');
      if (inProgress.length === 0) return Promise.resolve({ kind: 'none' });
      if (inProgress.length > 1) {
        return Promise.resolve({
          kind: 'context',
          text: `${inProgress.length} changes are in progress (${inProgress.map((s) => s.id).join(', ')}); work_status shows where each stands.`,
        });
      }
      const s = inProgress[0]!;
      return Promise.resolve({
        kind: 'context',
        text: `Change ${s.id} is in progress: ${s.done}/${s.total} tasks done${s.next ? `, next ${s.next.id} ${s.next.title}` : ''}. work_next("${s.id}") gives its acceptance criteria.`,
      });
    },
  },
};
