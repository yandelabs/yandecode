export {
  CodeIndex,
  type Definition,
  type FindSymbolOptions,
  type Reference,
  type SymbolRow,
  type SyncReport,
  type TextHit,
} from './code-index/code-index';
export { createDefaultChunker } from './chunking/router';
export { detectLanguage } from './chunking/languages';
export { ApproxTokenCounter, type TokenCounter } from './chunking/tokens';
export type { Chunk } from './chunking/types';
export { identifiersOf } from './lexical/identifiers';
export { buildIgnore, isProbablyBinary } from './scanner/rules';
export { listCandidatePaths } from './scanner/scanner';
export { extractSymbols, supportsSymbols, type CodeSymbol } from './symbols/extract';
