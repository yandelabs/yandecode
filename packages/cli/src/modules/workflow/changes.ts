import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
} from 'node:fs';
import { join } from 'node:path';
import { YandeCodeError, writeFileAtomic } from '@yandecode/core';

export interface Task {
  /** Explicit id (T1, 2.3, T-12) or positional (#n) when the line has none. */
  id: string;
  title: string;
  done: boolean;
  /** 1-based line in tasks.md. */
  line: number;
  /** Indented lines under the task (acceptance criteria, files, notes). */
  details: string[];
}

export type Stage =
  'discovery' | 'proposed' | 'designed' | 'specified' | 'planned' | 'in-progress' | 'implemented';

export interface ChangeStatus {
  id: string;
  stage: Stage;
  done: number;
  total: number;
  next: Task | null;
}

const TASK = /^- \[( |x|X)\]\s+(?:((?:[A-Za-z]+-?)?\d+(?:\.\d+)*)[:.)]?\s+)?(.*)$/;
const DETAIL = /^\s{2,}(?:[-*]\s+)?(.*\S)\s*$/;

export function parseTasks(markdown: string): Task[] {
  const tasks: Task[] = [];
  markdown.split('\n').forEach((line, i) => {
    const task = TASK.exec(line);
    if (task) {
      tasks.push({
        id: task[2] ?? `#${tasks.length + 1}`,
        title: task[3]!.trim(),
        done: task[1] !== ' ',
        line: i + 1,
        details: [],
      });
      return;
    }
    const detail = DETAIL.exec(line);
    if (detail && tasks.length > 0) tasks[tasks.length - 1]!.details.push(detail[1]!);
  });
  return tasks;
}

function slug(title: string): string {
  return (
    title
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'change'
  );
}

/**
 * Work in progress as OpenSpec-shaped folders: `<dir>/<id>/{proposal,design,tasks}.md`, `specs/`,
 * and an append-only `execution-log.md`. The stage is derived from what exists on disk, so any
 * session (or a Ralph loop iteration) resumes without conversation memory (ADR-024).
 */
export class ChangeRepository {
  constructor(
    readonly dir: string,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  private path(id: string, ...rest: string[]): string {
    return join(this.dir, id, ...rest);
  }

  private require(id: string): void {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id) || !existsSync(this.path(id))) {
      throw new YandeCodeError('CHANGE_UNKNOWN', `no change "${id}" in ${this.dir}`);
    }
  }

  create(input: { title: string; why: string; what?: string | undefined }): {
    id: string;
    dir: string;
  } {
    let id = slug(input.title);
    for (let n = 2; existsSync(this.path(id)); n++) id = `${slug(input.title)}-${n}`;
    mkdirSync(this.path(id), { recursive: true });
    writeFileAtomic(
      this.path(id, 'proposal.md'),
      [
        `# ${input.title}`,
        '',
        '## Why',
        '',
        input.why,
        '',
        '## What Changes',
        '',
        input.what ?? '- (to be defined)',
        '',
      ].join('\n'),
    );
    return { id, dir: this.path(id) };
  }

  list(): ChangeStatus[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((name) => name !== 'archive' && statSync(join(this.dir, name)).isDirectory())
      .sort()
      .map((id) => this.status(id));
  }

  tasks(id: string): Task[] {
    this.require(id);
    const file = this.path(id, 'tasks.md');
    return existsSync(file) ? parseTasks(readFileSync(file, 'utf8')) : [];
  }

  status(id: string): ChangeStatus {
    const tasks = this.tasks(id);
    const done = tasks.filter((t) => t.done).length;
    const specs = this.path(id, 'specs');
    const hasSpecs =
      existsSync(specs) &&
      readdirSync(specs, { recursive: true }).some((f) => String(f).endsWith('.md'));
    let stage: Stage = 'discovery';
    if (existsSync(this.path(id, 'proposal.md'))) stage = 'proposed';
    if (existsSync(this.path(id, 'design.md'))) stage = 'designed';
    if (hasSpecs) stage = 'specified';
    if (tasks.length > 0)
      stage = done === 0 ? 'planned' : done === tasks.length ? 'implemented' : 'in-progress';
    return { id, stage, done, total: tasks.length, next: tasks.find((t) => !t.done) ?? null };
  }

  /** Marks a task done in tasks.md and appends the evidence to execution-log.md. */
  check(id: string, taskId: string, note?: string): Task {
    const task = this.tasks(id).find((t) => t.id === taskId);
    if (!task) throw new YandeCodeError('TASK_UNKNOWN', `no task "${taskId}" in ${id}/tasks.md`);
    const file = this.path(id, 'tasks.md');
    const lines = readFileSync(file, 'utf8').split('\n');
    lines[task.line - 1] = lines[task.line - 1]!.replace(/^- \[ \]/, '- [x]');
    writeFileAtomic(file, lines.join('\n'));
    appendFileSync(
      this.path(id, 'execution-log.md'),
      `- ${this.clock().toISOString()} — ${task.id} done: ${task.title}${note ? ` — ${note}` : ''}\n`,
    );
    return { ...task, done: true };
  }

  archive(id: string): string {
    this.require(id);
    const target = join(this.dir, 'archive', `${this.clock().toISOString().slice(0, 10)}-${id}`);
    mkdirSync(join(this.dir, 'archive'), { recursive: true });
    renameSync(this.path(id), target);
    return target;
  }
}
