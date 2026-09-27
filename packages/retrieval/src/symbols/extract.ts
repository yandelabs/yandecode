import type Parser from 'web-tree-sitter';
import { createParser } from '@retrieval/chunking/parser-loader';

type Node = Parser.SyntaxNode;

export interface Unit {
  kind: string;
  symbol: string | null;
  startRow: number;
  endRow: number;
  members: Unit[];
}

interface Classified {
  kind: string;
  symbol: string | null;
}

interface Rules {
  unwrap: (n: Node) => Node;
  classify: (n: Node) => Classified | null;
  members: (n: Node, parentSymbol: string | null) => Unit[];
}

function name(n: Node): string | null {
  return n.childForFieldName('name')?.text ?? null;
}

function endRowOf(n: Node): number {
  return n.endPosition.column === 0 && n.endPosition.row > n.startPosition.row
    ? n.endPosition.row - 1
    : n.endPosition.row;
}

function unitOf(n: Node, kind: string, symbol: string | null, members: Unit[] = []): Unit {
  return { kind, symbol, startRow: n.startPosition.row, endRow: endRowOf(n), members };
}

function firstStringArg(call: Node): string | null {
  const args = call.childForFieldName('arguments');
  const s = args?.namedChildren.find((c) => c.type === 'string' || c.type === 'template_string');
  return s ? s.text.replace(/^['"`]|['"`]$/g, '') : null;
}

const TEST_FNS = new Set(['describe', 'it', 'test', 'context', 'suite']);

function jsMembers(body: Node | null, parent: string | null): Unit[] {
  if (!body) return [];
  const out: Unit[] = [];
  for (const m of body.namedChildren) {
    if (
      m.type === 'method_definition' ||
      m.type === 'abstract_method_signature' ||
      m.type === 'method_signature'
    ) {
      const n = name(m);
      out.push(unitOf(m, 'method', parent && n ? `${parent}/${n}` : n));
    }
  }
  return out;
}

/** Node types that declare a named symbol directly, by language family. */
const JS_DECLARATIONS: Readonly<Record<string, string>> = {
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
  function_declaration: 'function',
  generator_function_declaration: 'function',
  /** `declare function f(): T;` in .d.ts files. */
  function_signature: 'function',
};

const FUNCTION_VALUES = new Set(['arrow_function', 'function', 'function_expression']);

/** `const f = () => …` and friends count as functions; other variables are not symbols. */
function jsFunctionVariable(n: Node): Classified | null {
  const decl = n.namedChildren.find((c) => c.type === 'variable_declarator');
  const value = decl?.childForFieldName('value');
  if (!value || !FUNCTION_VALUES.has(value.type)) return null;
  return { kind: 'function', symbol: decl ? name(decl) : null };
}

/** `describe('…', …)` / `it('…', …)` blocks become `test` symbols named by their title. */
function jsTestCall(n: Node): Classified | null {
  const call = n.namedChildren[0];
  if (call?.type !== 'call_expression') return null;
  const fn = call.childForFieldName('function')?.text ?? '';
  return TEST_FNS.has(fn.split('.')[0] ?? '')
    ? { kind: 'test', symbol: firstStringArg(call) }
    : null;
}

/** `export …` and `declare …` (ambient, .d.ts) wrap the actual declaration. */
function jsUnwrap(n: Node): Node {
  const exported = n.type === 'export_statement' ? (n.childForFieldName('declaration') ?? n) : n;
  return exported.type === 'ambient_declaration'
    ? (exported.namedChildren[0] ?? exported)
    : exported;
}

const JS_RULES: Rules = {
  unwrap: jsUnwrap,
  classify: (n) => {
    const kind = JS_DECLARATIONS[n.type];
    if (kind) return { kind, symbol: name(n) };
    if (n.type === 'lexical_declaration' || n.type === 'variable_declaration') {
      return jsFunctionVariable(n);
    }
    return n.type === 'expression_statement' ? jsTestCall(n) : null;
  },
  members: (n, parent) =>
    n.type.endsWith('class_declaration') ? jsMembers(n.childForFieldName('body'), parent) : [],
};

const PY_RULES: Rules = {
  unwrap: (n) => (n.type === 'decorated_definition' ? (n.childForFieldName('definition') ?? n) : n),
  classify: (n) => {
    if (n.type === 'class_definition') return { kind: 'class', symbol: name(n) };
    if (n.type === 'function_definition') return { kind: 'function', symbol: name(n) };
    return null;
  },
  members: (n, parent) => {
    if (n.type !== 'class_definition') return [];
    const body = n.childForFieldName('body');
    const out: Unit[] = [];
    for (const raw of body?.namedChildren ?? []) {
      const m = PY_RULES.unwrap(raw);
      if (m.type === 'function_definition') {
        const nm = name(m);
        out.push(unitOf(raw, 'method', parent && nm ? `${parent}/${nm}` : nm));
      }
    }
    return out;
  },
};

/** `func (s *Server) Do()` → `Server/Do`. */
function goMethod(n: Node): Classified {
  const receiver = n.childForFieldName('receiver')?.namedChildren[0];
  const receiverType = receiver?.childForFieldName('type')?.text.replace(/^\*/, '') ?? null;
  const method = name(n);
  return { kind: 'method', symbol: receiverType && method ? `${receiverType}/${method}` : method };
}

const GO_TYPE_KINDS: Readonly<Record<string, string>> = {
  struct_type: 'struct',
  interface_type: 'interface',
};

function goType(n: Node): Classified {
  const spec = n.namedChildren.find((c) => c.type === 'type_spec');
  const shape = spec?.childForFieldName('type')?.type ?? '';
  return { kind: GO_TYPE_KINDS[shape] ?? 'type', symbol: spec ? name(spec) : null };
}

const GO_RULES: Rules = {
  unwrap: (n) => n,
  classify: (n) => {
    if (n.type === 'function_declaration') return { kind: 'function', symbol: name(n) };
    if (n.type === 'method_declaration') return goMethod(n);
    return n.type === 'type_declaration' ? goType(n) : null;
  },
  members: () => [],
};

const JAVA_RULES: Rules = {
  unwrap: (n) => n,
  classify: (n) => {
    if (n.type === 'class_declaration') return { kind: 'class', symbol: name(n) };
    if (n.type === 'interface_declaration') return { kind: 'interface', symbol: name(n) };
    if (n.type === 'enum_declaration') return { kind: 'enum', symbol: name(n) };
    if (n.type === 'record_declaration') return { kind: 'class', symbol: name(n) };
    return null;
  },
  members: (n, parent) => {
    const body = n.childForFieldName('body');
    const out: Unit[] = [];
    for (const m of body?.namedChildren ?? []) {
      if (m.type === 'method_declaration' || m.type === 'constructor_declaration') {
        const nm = name(m);
        out.push(unitOf(m, 'method', parent && nm ? `${parent}/${nm}` : nm));
      }
    }
    return out;
  },
};

const RUST_DECLARATIONS: Readonly<Record<string, string>> = {
  function_item: 'function',
  struct_item: 'struct',
  enum_item: 'enum',
  trait_item: 'trait',
  mod_item: 'module',
};

const RUST_RULES: Rules = {
  unwrap: (n) => n,
  classify: (n) => {
    if (n.type === 'impl_item') {
      return { kind: 'impl', symbol: n.childForFieldName('type')?.text ?? null };
    }
    const kind = RUST_DECLARATIONS[n.type];
    return kind ? { kind, symbol: name(n) } : null;
  },
  members: (n, parent) => {
    if (n.type !== 'impl_item' && n.type !== 'trait_item') return [];
    const body = n.childForFieldName('body');
    const out: Unit[] = [];
    for (const m of body?.namedChildren ?? []) {
      if (m.type === 'function_item' || m.type === 'function_signature_item') {
        const nm = name(m);
        out.push(unitOf(m, 'method', parent && nm ? `${parent}/${nm}` : nm));
      }
    }
    return out;
  },
};

export const RULES: Record<string, Rules> = {
  typescript: JS_RULES,
  tsx: JS_RULES,
  javascript: JS_RULES,
  python: PY_RULES,
  go: GO_RULES,
  java: JAVA_RULES,
  rust: RUST_RULES,
};

export interface CodeSymbol {
  /** Serena-style path of nested names, e.g. `AuthService/login`. */
  namePath: string;
  name: string;
  kind: string;
  /** 1-based inclusive line range. */
  startLine: number;
  endLine: number;
  /** First line of the declaration, trimmed (max 200 chars). */
  signature: string;
  /** name_path of the enclosing symbol, or null for top-level symbols. */
  parent: string | null;
}

export function supportsSymbols(language: string | null): boolean {
  return language !== null && language in RULES;
}

/** Top-level declaration units (with their members) of a parsed file, in source order. */
export async function extractUnits(content: string, language: string): Promise<Unit[]> {
  const rules = RULES[language];
  if (!rules) throw new Error(`unsupported language ${language}`);
  const parser = await createParser(language);
  const tree = parser.parse(content);
  try {
    const units: Unit[] = [];
    for (const top of tree.rootNode.namedChildren) {
      const inner = rules.unwrap(top);
      const cls = rules.classify(inner);
      if (!cls) continue;
      units.push(unitOf(top, cls.kind, cls.symbol, rules.members(inner, cls.symbol)));
    }
    return units.sort((a, b) => a.startRow - b.startRow);
  } finally {
    tree.delete();
    parser.delete();
  }
}

function signatureOf(lines: string[], row: number): string {
  const line = (lines[row] ?? '').trim().replace(/\s*\{\s*$/, '');
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

/** Named declarations of a file, flattened (parents before their members). */
export async function extractSymbols(content: string, language: string): Promise<CodeSymbol[]> {
  const lines = content.split('\n');
  const out: CodeSymbol[] = [];
  const visit = (unit: Unit, parent: string | null): void => {
    if (unit.symbol) {
      out.push({
        namePath: unit.symbol,
        name: unit.symbol.split('/').pop()!,
        kind: unit.kind,
        startLine: unit.startRow + 1,
        endLine: unit.endRow + 1,
        signature: signatureOf(lines, unit.startRow),
        parent,
      });
    }
    for (const member of unit.members) visit(member, unit.symbol);
  };
  for (const unit of await extractUnits(content, language)) visit(unit, null);
  return out;
}
