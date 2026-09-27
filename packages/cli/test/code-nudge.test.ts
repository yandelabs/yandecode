import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeConfig } from '@yandecode/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nudgeFor } from '@cli/modules/code/nudge';
import { codeModule } from '@cli/modules/code/definition';
import { moduleContext, requireWorkspace } from '@cli/modules/host';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'yc-nudge-'));
  writeFileSync(join(root, 'big.rs'), 'fn a() {}\n'.repeat(2000));
  writeFileSync(join(root, 'small.rs'), 'fn a() {}\n');
  writeFileSync(join(root, 'notes.md'), '# x\n'.repeat(5000));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('nudgeFor', () => {
  it.each([
    ['Grep', { pattern: 'fn lex', path: 'src' }, 'search'],
    ['Glob', { pattern: '**/*lexer*.rs' }, 'search'],
    ['Bash', { command: 'grep -rn "TokenKind::Integer" compiler' }, 'search'],
    ['Bash', { command: 'cd compiler && rg lower_place' }, 'search'],
    ['Bash', { command: "find . -name '*.rs' | xargs grep -l Mutex" }, 'search'],
    ['Bash', { command: "sed -n '1400,1500p' compiler/paco-mir/src/lower.rs" }, 'read'],
    ['Bash', { command: 'cat src/lib.rs' }, 'read'],
    ['Read', { file_path: 'big.rs' }, 'read'],
  ])('%s %o → %s', (tool, input, kind) => {
    expect(nudgeFor(tool, input, root)?.kind).toBe(kind);
  });

  it.each([
    ['Read', { file_path: 'small.rs' }],
    ['Read', { file_path: 'big.rs', offset: 10, limit: 40 }],
    ['Read', { file_path: 'notes.md' }],
    ['Bash', { command: 'git status' }],
    ['Bash', { command: 'echo "grep -rn is fine"' }],
    ['Bash', { command: 'cat README.md' }],
  ])('%s %o → no nudge', (tool, input) => {
    expect(nudgeFor(tool, input, root)).toBeNull();
  });

  it('names the yandecode tool to use in the hint', () => {
    expect(nudgeFor('Grep', { pattern: 'x' }, root)?.text).toContain('code_search');
    expect(nudgeFor('Read', { file_path: 'big.rs' }, root)?.text).toContain('code_symbols');
  });
});

describe('code module PreToolUse', () => {
  it('hints once per session and kind', async () => {
    writeConfig(root, { version: 2, modules: ['code'] });
    const ctx = moduleContext(requireWorkspace(root), codeModule);
    const runtime = await codeModule.load();
    const hook = (session: string): Promise<{ kind: string }> =>
      runtime.hooks!.PreToolUse!(
        { session_id: session, tool_name: 'Grep', tool_input: { pattern: 'x' } },
        ctx,
      );
    expect((await hook('s1')).kind).toBe('context');
    expect((await hook('s1')).kind).toBe('none');
    expect((await hook('s2')).kind).toBe('context');
    await runtime.dispose?.();
  });
});
