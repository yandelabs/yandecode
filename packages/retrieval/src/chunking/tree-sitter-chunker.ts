import type { TokenCounter } from './tokens';
import { extractUnits, supportsSymbols, type Unit } from '@retrieval/symbols/extract';
import type { LineChunker } from './line-chunker';
import { DEFAULT_LIMITS, type Chunk, type ChunkLimits, type Chunker } from './types';

export class TreeSitterChunker implements Chunker {
  constructor(
    private readonly counter: TokenCounter,
    private readonly line: LineChunker,
    private readonly limits: ChunkLimits = DEFAULT_LIMITS,
  ) {}

  supports(language: string | null): boolean {
    return supportsSymbols(language);
  }

  async chunk(_path: string, content: string, language: string | null): Promise<Chunk[]> {
    if (!this.supports(language)) throw new Error(`unsupported language ${String(language)}`);
    const units = await extractUnits(content, language!);
    const lines = content.split('\n');

    const out: Chunk[] = [];
    let cursor = 0;
    for (const u of units) {
      if (u.startRow > cursor) out.push(...(await this.gap(lines, cursor, u.startRow - 1)));
      out.push(...(await this.unitChunks(lines, u)));
      cursor = Math.max(cursor, u.endRow + 1);
    }
    if (cursor <= lines.length - 1) out.push(...(await this.gap(lines, cursor, lines.length - 1)));
    return out.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
  }

  private async gap(lines: string[], startRow: number, endRow: number): Promise<Chunk[]> {
    let start = startRow;
    let end = endRow;
    while (start <= end && (lines[start] ?? '').trim().length === 0) start++;
    while (end >= start && (lines[end] ?? '').trim().length === 0) end--;
    if (start > end) return [];
    const slice = lines.slice(start, end + 1);
    return this.line.chunkLines(slice, start + 1, 'module', null);
  }

  private async unitChunks(lines: string[], u: Unit): Promise<Chunk[]> {
    const text = lines.slice(u.startRow, u.endRow + 1).join('\n');
    const tokens = await this.counter.countTokens(text);
    if (tokens <= this.limits.maxTokens) {
      return [
        {
          kind: u.kind,
          symbol: u.symbol,
          startLine: u.startRow + 1,
          endLine: u.endRow + 1,
          content: text,
        },
      ];
    }
    if (u.members.length === 0)
      return this.line.chunkLines(
        lines.slice(u.startRow, u.endRow + 1),
        u.startRow + 1,
        u.kind,
        u.symbol,
      );

    const out: Chunk[] = [];
    const covered = new Set<number>();
    for (const m of u.members) {
      for (let r = m.startRow; r <= m.endRow; r++) covered.add(r);
      const mText = lines.slice(m.startRow, m.endRow + 1).join('\n');
      const mTokens = await this.counter.countTokens(mText);
      if (mTokens <= this.limits.maxTokens)
        out.push({
          kind: m.kind,
          symbol: m.symbol,
          startLine: m.startRow + 1,
          endLine: m.endRow + 1,
          content: mText,
        });
      else
        out.push(
          ...(await this.line.chunkLines(
            lines.slice(m.startRow, m.endRow + 1),
            m.startRow + 1,
            m.kind,
            m.symbol,
          )),
        );
    }
    const shellRows: number[] = [];
    for (let r = u.startRow; r <= u.endRow; r++) if (!covered.has(r)) shellRows.push(r);
    const shellLines = shellRows.map((r) => lines[r] ?? '');
    if (shellLines.some((l) => l.trim().length > 0)) {
      const first = shellRows[0]!;
      const shell = await this.line.chunkLines(shellLines, first + 1, u.kind, u.symbol);
      // shell rows are not contiguous; report the unit's full range for attribution
      out.push(...shell.map((c) => ({ ...c, startLine: u.startRow + 1, endLine: u.endRow + 1 })));
    }
    return out;
  }
}
