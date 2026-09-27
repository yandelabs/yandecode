import type Parser from 'web-tree-sitter';
import { createParser } from '@retrieval/chunking/parser-loader';

type Node = Parser.SyntaxNode;

const JS_LANGUAGES = new Set(['typescript', 'tsx', 'javascript']);

function stripQuotes(text: string): string {
  return text.replace(/^['"`]|['"`]$/g, '');
}

function jsSpecifiers(root: Node): string[] {
  const out: string[] = [];
  for (const top of root.namedChildren) {
    if (top.type !== 'import_statement' && top.type !== 'export_statement') continue;
    const source = top.childForFieldName('source');
    if (source) out.push(stripQuotes(source.text));
  }
  return out;
}

function pythonSpecifiers(root: Node): string[] {
  const out: string[] = [];
  for (const top of root.namedChildren) {
    if (top.type === 'import_statement') {
      for (const child of top.namedChildren) {
        if (child.type === 'dotted_name') out.push(child.text);
        else if (child.type === 'aliased_import') {
          const dotted = child.namedChildren.find((c) => c.type === 'dotted_name');
          if (dotted) out.push(dotted.text);
        }
      }
    } else if (top.type === 'import_from_statement') {
      const moduleName = top.childForFieldName('module_name');
      if (moduleName) out.push(moduleName.text);
    }
  }
  return out;
}

export async function extractImports(content: string, language: string | null): Promise<string[]> {
  if (language === null || !(JS_LANGUAGES.has(language) || language === 'python')) return [];
  const parser = await createParser(language);
  try {
    const tree = parser.parse(content);
    try {
      return JS_LANGUAGES.has(language)
        ? jsSpecifiers(tree.rootNode)
        : pythonSpecifiers(tree.rootNode);
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}
