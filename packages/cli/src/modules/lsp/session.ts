import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { JsonRpcConnection } from './jsonrpc';

export interface Position {
  path: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
}

export interface Diagnostic {
  line: number;
  column: number;
  severity: 'error' | 'warning' | 'info' | 'hint';
  message: string;
  source?: string;
}

interface LspRange {
  start: { line: number; character: number };
}
interface LspLocation {
  uri?: string;
  range?: LspRange;
  targetUri?: string;
  targetSelectionRange?: LspRange;
}
interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  message: string;
  source?: string;
}

const SEVERITY: Readonly<Record<number, Diagnostic['severity']>> = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'hint',
};

function toDiagnostic(d: LspDiagnostic): Diagnostic {
  return {
    line: d.range.start.line + 1,
    column: d.range.start.character + 1,
    severity: SEVERITY[d.severity ?? 1] ?? 'error',
    message: d.message,
    ...(d.source ? { source: d.source } : {}),
  };
}
const QUIET_MS = 700;

export interface SessionOptions {
  root: string;
  command: string;
  args: readonly string[];
  languageIdFor: (path: string) => string;
}

/** One running language server for a project root. Files are synced from disk before each query. */
export class LspSession {
  private readonly versions = new Map<string, { version: number; text: string }>();
  private readonly published = new Map<string, { seq: number; items: LspDiagnostic[] }>();
  private seq = 0;
  private warm = false;

  private constructor(
    private readonly rpc: JsonRpcConnection,
    private readonly options: SessionOptions,
  ) {
    rpc.onNotification('textDocument/publishDiagnostics', (params) => {
      const { uri, diagnostics } = params as { uri: string; diagnostics: LspDiagnostic[] };
      this.published.set(uri, { seq: ++this.seq, items: diagnostics });
    });
    rpc.onRequest('workspace/configuration', (params) =>
      (params as { items: unknown[] }).items.map(() => null),
    );
    for (const method of [
      'client/registerCapability',
      'window/workDoneProgress/create',
      'workspace/workspaceFolders',
    ]) {
      rpc.onRequest(method, () => null);
    }
  }

  static async start(options: SessionOptions): Promise<LspSession> {
    const child = spawn(options.command, [...options.args], {
      cwd: options.root,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stderr.resume();
    const session = new LspSession(new JsonRpcConnection(child), options);
    const rootUri = pathToFileURL(options.root).href;
    await session.rpc.request(
      'initialize',
      {
        processId: process.pid,
        rootUri,
        workspaceFolders: [{ uri: rootUri, name: 'root' }],
        capabilities: {
          textDocument: {
            synchronization: { didSave: false },
            references: {},
            definition: { linkSupport: true },
            publishDiagnostics: {},
          },
          workspace: { configuration: true, workspaceFolders: true },
        },
      },
      60_000,
    );
    session.rpc.notify('initialized', {});
    return session;
  }

  private uri(path: string): string {
    return pathToFileURL(join(this.options.root, path)).href;
  }

  /** Opens or refreshes the file in the server from disk; returns true when the text changed. */
  private sync(path: string): boolean {
    const uri = this.uri(path);
    const text = readFileSync(join(this.options.root, path), 'utf8');
    const open = this.versions.get(uri);
    if (!open) {
      this.versions.set(uri, { version: 1, text });
      this.rpc.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: this.options.languageIdFor(path), version: 1, text },
      });
      return true;
    }
    if (open.text === text) return false;
    const version = open.version + 1;
    this.versions.set(uri, { version, text });
    this.rpc.notify('textDocument/didChange', {
      textDocument: { uri, version },
      contentChanges: [{ text }],
    });
    return true;
  }

  private toPositions(result: unknown): Position[] {
    const list = (Array.isArray(result) ? result : result ? [result] : []) as LspLocation[];
    return list
      .map((loc) => {
        const uri = loc.targetUri ?? loc.uri!;
        const start = (loc.targetSelectionRange ?? loc.range)!.start;
        return {
          path: relative(this.options.root, fileURLToPath(uri)).split('\\').join('/'),
          line: start.line + 1,
          column: start.character + 1,
        };
      })
      .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
  }

  /**
   * Servers answer from a partially loaded project right after the first didOpen (tsserver returns
   * only open files). Their first publishDiagnostics for that file signals the project is loaded.
   */
  private async warmUp(path: string): Promise<void> {
    this.sync(path);
    if (this.warm) return;
    const uri = this.uri(path);
    const deadline = Date.now() + 15_000;
    while (!this.published.has(uri) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    this.warm = true;
  }

  /** 0-based position, as LSP expects. */
  async references(path: string, line: number, character: number): Promise<Position[]> {
    await this.warmUp(path);
    const result = await this.rpc.request('textDocument/references', {
      textDocument: { uri: this.uri(path) },
      position: { line, character },
      context: { includeDeclaration: true },
    });
    return this.toPositions(result);
  }

  async definition(path: string, line: number, character: number): Promise<Position[]> {
    await this.warmUp(path);
    const result = await this.rpc.request('textDocument/definition', {
      textDocument: { uri: this.uri(path) },
      position: { line, character },
    });
    return this.toPositions(result);
  }

  private seqOf(uri: string): number {
    return this.published.get(uri)?.seq ?? 0;
  }

  /** Waits for a publish newer than `after`, then until none arrives for QUIET_MS. */
  private async settle(uri: string, after: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let last = after;
    let quietSince = Date.now();
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      const current = this.seqOf(uri);
      if (current !== last) {
        last = current;
        quietSince = Date.now();
      } else if (current > after && Date.now() - quietSince >= QUIET_MS) {
        return;
      }
    }
  }

  /**
   * Diagnostics for the file as it is on disk now. Servers often publish in several rounds
   * (syntax, then types), so after a change this waits for the stream of updates to go quiet.
   */
  async diagnostics(path: string, timeoutMs = 10_000): Promise<Diagnostic[]> {
    const uri = this.uri(path);
    const before = this.seqOf(uri);
    const changed = this.sync(path);
    if (changed || before === 0) await this.settle(uri, before, timeoutMs);
    return (this.published.get(uri)?.items ?? []).map(toDiagnostic);
  }

  async shutdown(): Promise<void> {
    try {
      await this.rpc.request('shutdown', null, 2_000);
      this.rpc.notify('exit', null);
    } catch {
      // Already gone or unresponsive; kill below.
    }
    this.rpc.kill();
  }
}
