import type { FileGraph } from './types';

export interface PageRankOptions {
  dampingFactor?: number;
  iterations?: number;
}

function adjacency(
  graph: FileGraph,
  nodes: readonly string[],
): { outDegree: Map<string, number>; incoming: Map<string, string[]> } {
  const outDegree = new Map<string, number>();
  const incoming = new Map<string, string[]>(nodes.map((node) => [node, []]));
  for (const node of nodes) {
    const targets = [...(graph.edges.get(node) ?? [])];
    outDegree.set(node, targets.length);
    for (const target of targets) incoming.get(target)?.push(node);
  }
  return { outDegree, incoming };
}

export function pagerank(graph: FileGraph, options: PageRankOptions = {}): Map<string, number> {
  const d = options.dampingFactor ?? 0.85;
  const iterations = options.iterations ?? 20;
  const nodes = [...graph.nodes];
  const n = nodes.length;
  if (n === 0) return new Map();

  const { outDegree, incoming } = adjacency(graph, nodes);

  let scores = new Map(nodes.map((node) => [node, 1 / n]));
  for (let iter = 0; iter < iterations; iter += 1) {
    const danglingSum = nodes
      .filter((node) => (outDegree.get(node) ?? 0) === 0)
      .reduce((sum, node) => sum + (scores.get(node) ?? 0), 0);
    const next = new Map<string, number>();
    for (const node of nodes) {
      let incomingSum = 0;
      for (const source of incoming.get(node) ?? []) {
        const degree = outDegree.get(source) ?? 0;
        if (degree > 0) incomingSum += (scores.get(source) ?? 0) / degree;
      }
      next.set(node, (1 - d) / n + d * (danglingSum / n + incomingSum));
    }
    scores = next;
  }
  return scores;
}
