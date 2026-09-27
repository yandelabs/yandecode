import { describe, expect, it } from 'vitest';
import { extractImports } from '@retrieval/graph/import-extractor';

describe('extractImports', () => {
  it('extracts static ESM import sources', async () => {
    const src = `import { x } from './x.js';\nimport y from '../y.js';\nimport './side-effect.js';\n`;
    expect(await extractImports(src, 'typescript')).toEqual([
      './x.js',
      '../y.js',
      './side-effect.js',
    ]);
  });

  it('extracts re-export sources', async () => {
    const src = `export { x } from './x.js';\nexport * from './y.js';\n`;
    expect(await extractImports(src, 'javascript')).toEqual(['./x.js', './y.js']);
  });

  it('ignores bare module specifiers but still returns them (resolution happens later)', async () => {
    const src = `import { z } from 'zod';\nimport { a } from './a.js';\n`;
    expect(await extractImports(src, 'typescript')).toEqual(['zod', './a.js']);
  });

  it('extracts python import and from-import module names, including relative imports', async () => {
    const src = `import os\nfrom .foo import bar\nfrom . import baz\nfrom ..pkg.mod import qux\n`;
    expect(await extractImports(src, 'python')).toEqual(['os', '.foo', '.', '..pkg.mod']);
  });

  it('returns an empty array for unsupported or null languages', async () => {
    expect(await extractImports('package a\nfunc F() {}\n', 'go')).toEqual([]);
    expect(await extractImports('irrelevant', null)).toEqual([]);
  });
});
