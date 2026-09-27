import type { TokenCounter } from './tokens';
import { LineChunker } from './line-chunker';
import { MarkdownChunker } from './markdown-chunker';
import { TreeSitterChunker } from './tree-sitter-chunker';
import { DEFAULT_LIMITS, type Chunk, type ChunkLimits, type Chunker } from './types';

export class ChunkerRouter implements Chunker {
  constructor(
    private readonly treeSitter: TreeSitterChunker,
    private readonly markdown: MarkdownChunker,
    private readonly line: LineChunker,
  ) {}

  async chunk(path: string, content: string, language: string | null): Promise<Chunk[]> {
    if (language === 'markdown') return this.markdown.chunk(path, content, language);
    if (this.treeSitter.supports(language)) {
      try {
        return await this.treeSitter.chunk(path, content, language);
      } catch {
        return this.line.chunk(path, content, language);
      }
    }
    return this.line.chunk(path, content, language ?? 'text');
  }
}

export function createDefaultChunker(
  counter: TokenCounter,
  limits: ChunkLimits = DEFAULT_LIMITS,
): ChunkerRouter {
  const line = new LineChunker(counter, limits);
  return new ChunkerRouter(
    new TreeSitterChunker(counter, line, limits),
    new MarkdownChunker(counter, line, limits),
    line,
  );
}
