import { statSync } from 'node:fs';
import { extname, isAbsolute, join } from 'node:path';

export interface Nudge {
  /** One hint per kind per session. */
  kind: 'search' | 'read';
  text: string;
}

const CODE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.py',
  '.rs',
  '.go',
  '.java',
  '.kt',
  '.c',
  '.h',
  '.cc',
  '.cpp',
  '.hpp',
  '.cs',
  '.rb',
  '.php',
  '.swift',
  '.scala',
]);
/** Files above this size are worth outlining first (~300 lines of code). */
const LARGE_FILE_BYTES = 12_000;

const SEARCH: Nudge = {
  kind: 'search',
  text: 'yandecode: to find where code is defined or handled, `code_search(query)` returns path:line rows with signatures (identifiers, `Class/method`, file fragments or plain words), and `code_references(name)` lists usages — cheaper than grep/find over source files.',
};
const READ: Nudge = {
  kind: 'read',
  text: 'yandecode: `code_symbols(path)` lists a file’s functions and types with line ranges, and `code_definition(name)` returns just one of them — read or cat whole source files only when you will edit most of them.',
};

const isCode = (path: string): boolean => CODE_EXTENSIONS.has(extname(path).toLowerCase());

function segments(command: string): string[] {
  return command
    .replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''")
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim());
}

function bashNudge(command: string): Nudge | null {
  const parts = segments(command);
  if (
    parts.some(
      (s) =>
        /^(grep|egrep|rg|ag|ack|git grep)\b/.test(s) || /^find\b.*-(name|path|iname)\b/.test(s),
    )
  ) {
    return SEARCH;
  }
  // Reading source through the shell: cat/head/tail/sed -n on a code file (arguments are quoted-stripped, so
  // look at the raw command for the file name).
  const reads = /^(cat|head|tail|sed -n|nl|less|more)\b/;
  if (
    parts.some((s) => reads.test(s)) &&
    [...command.matchAll(/[\w./-]+\.\w+/g)].some((m) => isCode(m[0]))
  ) {
    return READ;
  }
  return null;
}

function readNudge(input: Record<string, unknown>, root: string): Nudge | null {
  const path = input.file_path;
  if (
    typeof path !== 'string' ||
    !isCode(path) ||
    input.offset !== undefined ||
    input.limit !== undefined
  )
    return null;
  const size =
    statSync(isAbsolute(path) ? path : join(root, path), { throwIfNoEntry: false })?.size ?? 0;
  return size > LARGE_FILE_BYTES ? READ : null;
}

/** The hint for a built-in tool call that a yandecode code tool does better, if any. */
export function nudgeFor(tool: string, input: Record<string, unknown>, root: string): Nudge | null {
  if (tool === 'Grep' || tool === 'Glob') return SEARCH;
  if (tool === 'Bash' && typeof input.command === 'string') return bashNudge(input.command);
  if (tool === 'Read') return readNudge(input, root);
  return null;
}
