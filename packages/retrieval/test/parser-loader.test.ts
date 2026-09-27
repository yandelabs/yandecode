import { describe, expect, it } from 'vitest';
import { createParser, loadLanguage } from '@retrieval/chunking/parser-loader';

describe('parser-loader', () => {
  it('loads a known grammar and parses with it', async () => {
    const parser = await createParser('typescript');
    const tree = parser.parse('const x = 1;\n');
    expect(tree.rootNode.type).toBe('program');
    tree.delete();
    parser.delete();
  });

  it('rejects an unknown language', async () => {
    await expect(loadLanguage('cobol')).rejects.toThrow('no grammar for cobol');
  });
});
