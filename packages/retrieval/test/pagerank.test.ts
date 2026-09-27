import { describe, expect, it } from 'vitest';
import { pagerank } from '@retrieval/graph/pagerank';
import type { FileGraph } from '@retrieval/graph/types';

function graph(edges: Record<string, string[]>): FileGraph {
  const nodes = new Set<string>();
  for (const [from, tos] of Object.entries(edges)) {
    nodes.add(from);
    for (const to of tos) nodes.add(to);
  }
  return { nodes, edges: new Map(Object.entries(edges).map(([k, v]) => [k, new Set(v)])) };
}

describe('pagerank', () => {
  it('ranks a node referenced by everyone above its referencers', () => {
    // a -> b, a -> c, b -> c: c is reachable from both a and b, directly and indirectly.
    const scores = pagerank(graph({ a: ['b', 'c'], b: ['c'], c: [] }));
    expect(scores.get('c')!).toBeGreaterThan(scores.get('b')!);
    expect(scores.get('b')!).toBeGreaterThan(scores.get('a')!);
  });

  it('produces scores that sum to approximately 1', () => {
    const scores = pagerank(graph({ a: ['b'], b: ['a'] }));
    const total = [...scores.values()].reduce((s, v) => s + v, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it('assigns every node a score even with zero edges', () => {
    const scores = pagerank({ nodes: new Set(['a', 'b']), edges: new Map() });
    expect(scores.get('a')).toBeCloseTo(0.5, 5);
    expect(scores.get('b')).toBeCloseTo(0.5, 5);
  });

  it('returns an empty map for an empty graph', () => {
    expect(pagerank({ nodes: new Set(), edges: new Map() }).size).toBe(0);
  });
});
