import { describe, expect, it } from 'vitest';
import { buildFileGraph } from '@retrieval/graph/symbol-graph';

describe('buildFileGraph', () => {
  it('resolves relative TS/JS specifiers against the importing file, trying known extensions', () => {
    const files = [
      { path: 'src/a.ts', language: 'typescript', imports: ['./b', '../lib/c.js'] },
      { path: 'src/b.ts', language: 'typescript', imports: [] },
      { path: 'lib/c.js', language: 'javascript', imports: [] },
    ];
    const graph = buildFileGraph(files);
    expect(graph.nodes).toEqual(new Set(['src/a.ts', 'src/b.ts', 'lib/c.js']));
    expect(graph.edges.get('src/a.ts')).toEqual(new Set(['src/b.ts', 'lib/c.js']));
  });

  it('resolves a relative import to an index file when the bare path is a directory', () => {
    const files = [
      { path: 'src/a.ts', language: 'typescript', imports: ['./util'] },
      { path: 'src/util/index.ts', language: 'typescript', imports: [] },
    ];
    const graph = buildFileGraph(files);
    expect(graph.edges.get('src/a.ts')).toEqual(new Set(['src/util/index.ts']));
  });

  it('resolves a .js specifier to a .ts source file (ESM-style TS imports, as used in this repo)', () => {
    const files = [
      { path: 'src/router.ts', language: 'typescript', imports: ['./line-chunker.js'] },
      { path: 'src/line-chunker.ts', language: 'typescript', imports: [] },
    ];
    const graph = buildFileGraph(files);
    expect(graph.edges.get('src/router.ts')).toEqual(new Set(['src/line-chunker.ts']));
  });

  it('resolves python relative imports by converting leading dots to path segments', () => {
    const files = [
      { path: 'pkg/a.py', language: 'python', imports: ['.foo', '.'] },
      { path: 'pkg/foo.py', language: 'python', imports: [] },
      { path: 'pkg/__init__.py', language: 'python', imports: [] },
    ];
    const graph = buildFileGraph(files);
    expect(graph.edges.get('pkg/a.py')).toEqual(new Set(['pkg/foo.py', 'pkg/__init__.py']));
  });

  it('drops a specifier that does not resolve to a known file, and every non-relative specifier', () => {
    const files = [{ path: 'src/a.ts', language: 'typescript', imports: ['zod', './missing.ts'] }];
    const graph = buildFileGraph(files);
    expect(graph.edges.get('src/a.ts')).toEqual(new Set());
  });
});
