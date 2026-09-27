import { createRequire } from 'node:module';
import Parser from 'web-tree-sitter';
import { GRAMMAR_FILES } from './languages';

const require = createRequire(import.meta.url);

let parserInit: Promise<void> | null = null;
const languages = new Map<string, Promise<Parser.Language>>();

export async function loadLanguage(language: string): Promise<Parser.Language> {
  parserInit ??= Parser.init();
  await parserInit;
  let lang = languages.get(language);
  if (!lang) {
    const file = GRAMMAR_FILES[language];
    if (!file) throw new Error(`no grammar for ${language}`);
    lang = Parser.Language.load(require.resolve(`tree-sitter-wasms/out/${file}`));
    languages.set(language, lang);
  }
  return lang;
}

export async function createParser(language: string): Promise<Parser> {
  const lang = await loadLanguage(language);
  const parser = new Parser();
  parser.setLanguage(lang);
  return parser;
}
