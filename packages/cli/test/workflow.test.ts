import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeConfig } from '@yandecode/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ModuleContext, ModuleRuntime } from '@cli/modules/contract';
import { moduleContext, requireWorkspace } from '@cli/modules/host';
import { ChangeRepository, parseTasks } from '@cli/modules/workflow/changes';
import { workflowModule } from '@cli/modules/workflow/definition';

describe('parseTasks', () => {
  it('reads ids, state and indented acceptance criteria', () => {
    const md = [
      '# Tasks',
      '- [x] T1 Add config schema',
      '- [ ] T2 Load config',
      '  - AC: missing file returns defaults',
      '  - AC: invalid JSON fails with the file path',
      '- [ ] Write docs',
      '',
    ].join('\n');
    expect(parseTasks(md)).toEqual([
      { id: 'T1', title: 'Add config schema', done: true, line: 2, details: [] },
      {
        id: 'T2',
        title: 'Load config',
        done: false,
        line: 3,
        details: ['AC: missing file returns defaults', 'AC: invalid JSON fails with the file path'],
      },
      { id: '#3', title: 'Write docs', done: false, line: 6, details: [] },
    ]);
  });
});

describe('ChangeRepository', () => {
  let root: string;
  let repo: ChangeRepository;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'yc-wf-'));
    repo = new ChangeRepository(join(root, 'docs/changes'), () => new Date('2026-09-26T12:00:00Z'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('derives the stage from the artifacts on disk', () => {
    const { id } = repo.create({ title: 'Add rate limiting', why: 'Abuse on /login.' });
    expect(id).toBe('add-rate-limiting');
    expect(repo.status(id).stage).toBe('proposed');
    writeFileSync(join(root, 'docs/changes', id, 'design.md'), '# Design\n');
    expect(repo.status(id).stage).toBe('designed');
    writeFileSync(
      join(root, 'docs/changes', id, 'tasks.md'),
      '- [ ] T1 Limiter\n- [ ] T2 Wire it\n',
    );
    expect(repo.status(id)).toMatchObject({ stage: 'planned', done: 0, total: 2 });
    repo.check(id, 'T1', 'unit tests green');
    expect(repo.status(id)).toMatchObject({ stage: 'in-progress', done: 1, next: { id: 'T2' } });
    repo.check(id, 'T2');
    expect(repo.status(id).stage).toBe('implemented');
  });

  it('records checks in an append-only execution log', () => {
    const { id } = repo.create({ title: 'X', why: 'y' });
    writeFileSync(join(root, 'docs/changes', id, 'tasks.md'), '- [ ] T1 Do it\n');
    repo.check(id, 'T1', 'vitest: 12 passed');
    const log = readFileSync(join(root, 'docs/changes', id, 'execution-log.md'), 'utf8');
    expect(log).toContain('2026-09-26T12:00:00.000Z — T1 done: Do it — vitest: 12 passed');
    expect(() => repo.check(id, 'T9')).toThrow(/no task "T9"/);
  });

  it('archives a change with a date prefix and lists archived separately', () => {
    const { id } = repo.create({ title: 'Old work', why: 'y' });
    repo.archive(id);
    expect(existsSync(join(root, 'docs/changes/archive/2026-09-26-old-work/proposal.md'))).toBe(
      true,
    );
    expect(repo.list().map((c) => c.id)).toEqual([]);
  });
});

describe('workflow runtime', () => {
  let root: string;
  let ctx: ModuleContext;
  let runtime: ModuleRuntime;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'yc-wfrt-'));
    writeConfig(root, { version: 2, modules: ['workflow'] });
    ctx = moduleContext(requireWorkspace(root), workflowModule);
    runtime = await workflowModule.load();
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const tool = (
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ text: string; isError?: boolean }> => runtime.tools![name]!(args, ctx);

  it('resumes an interrupted change from files alone', async () => {
    await tool('work_new', { title: 'Add rate limiting', why: 'Abuse on /login.' });
    writeFileSync(
      join(root, 'docs/changes/add-rate-limiting/tasks.md'),
      '- [x] T1 Limiter\n- [ ] T2 Wire it\n  - AC: 429 after 5 tries\n',
    );
    const status = await tool('work_status', {});
    expect(status.text).toContain('add-rate-limiting — in-progress, 1/2 tasks');
    const next = await tool('work_next', { id: 'add-rate-limiting' });
    expect(next.text).toContain('T2 Wire it');
    expect(next.text).toContain('AC: 429 after 5 tries');
    const start = await runtime.hooks!.SessionStart!({}, ctx);
    expect(start.kind === 'context' && start.text).toContain(
      'Change add-rate-limiting is in progress: 1/2 tasks done, next T2 Wire it',
    );
  });

  it('says nothing at session start when changes are only planned, and summarizes several', async () => {
    await tool('work_new', { title: 'Planned one', why: 'y' });
    writeFileSync(join(root, 'docs/changes/planned-one/tasks.md'), '- [ ] T1 Do it\n');
    expect(await runtime.hooks!.SessionStart!({}, ctx)).toEqual({ kind: 'none' });
    for (const id of ['a-change', 'b-change']) {
      await tool('work_new', { title: id, why: 'y' });
      writeFileSync(join(root, `docs/changes/${id}/tasks.md`), '- [x] T1 Done\n- [ ] T2 Left\n');
    }
    const start = await runtime.hooks!.SessionStart!({}, ctx);
    expect(start.kind === 'context' && start.text).toBe(
      '2 changes are in progress (a-change, b-change); work_status shows where each stands.',
    );
  });

  it('uses an existing openspec/changes directory', async () => {
    mkdirSync(join(root, 'openspec', 'changes'), { recursive: true });
    await runtime.dispose?.();
    runtime = await workflowModule.load();
    await tool('work_new', { title: 'Spec me', why: 'because' });
    expect(existsSync(join(root, 'openspec/changes/spec-me/proposal.md'))).toBe(true);
  });
});
