import { describe, expect, it } from 'vitest';
import { extractSymbols } from '@retrieval/symbols/extract';

const ts = `import { x } from './x';

export class AuthService {
  constructor(private readonly store: Store) {}

  async login(user: string, password: string): Promise<Token> {
    return this.store.issue(user);
  }
}

export interface Token {
  value: string;
}

export const hashPassword = (raw: string): string => raw;

function helper() {}
`;

describe('extractSymbols', () => {
  it('returns nested name paths, kinds, 1-based ranges and signatures', async () => {
    const symbols = await extractSymbols(ts, 'typescript');
    expect(symbols.map((s) => [s.namePath, s.kind, s.startLine, s.endLine, s.parent])).toEqual([
      ['AuthService', 'class', 3, 9, null],
      ['AuthService/constructor', 'method', 4, 4, 'AuthService'],
      ['AuthService/login', 'method', 6, 8, 'AuthService'],
      ['Token', 'interface', 11, 13, null],
      ['hashPassword', 'function', 15, 15, null],
      ['helper', 'function', 17, 17, null],
    ]);
    const login = symbols.find((s) => s.name === 'login')!;
    expect(login.signature).toBe('async login(user: string, password: string): Promise<Token>');
  });

  it('handles ambient declarations in .d.ts files', async () => {
    const dts =
      'export declare function connect(url: string): Promise<Client>;\nexport declare class Client {\n  close(): Promise<void>;\n}\ndeclare const version: string;\n';
    const symbols = await extractSymbols(dts, 'typescript');
    expect(symbols.map((s) => [s.namePath, s.kind])).toEqual([
      ['connect', 'function'],
      ['Client', 'class'],
      ['Client/close', 'method'],
    ]);
  });

  it('handles python methods', async () => {
    const py = `class Auth:\n    def login(self, u):\n        return u\n\ndef main():\n    pass\n`;
    const symbols = await extractSymbols(py, 'python');
    expect(symbols.map((s) => s.namePath)).toEqual(['Auth', 'Auth/login', 'main']);
  });

  it('throws for languages without symbol rules', async () => {
    await expect(extractSymbols('x', 'markdown')).rejects.toThrow(/unsupported language/);
  });
});
