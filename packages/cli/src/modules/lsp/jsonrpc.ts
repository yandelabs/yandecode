import type { ChildProcessWithoutNullStreams } from 'node:child_process';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface Message {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { message: string };
}

type Handler = (params: unknown) => unknown;

/** JSON-RPC 2.0 over an LSP stdio stream (Content-Length framing). */
export class JsonRpcConnection {
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notificationHandlers = new Map<string, Handler>();
  private readonly requestHandlers = new Map<string, Handler>();
  private closed: Error | null = null;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on('data', (chunk: Buffer) => {
      this.receive(chunk);
    });
    child.on('exit', (code) => {
      this.fail(new Error(`language server exited (code ${code ?? 'signal'})`));
    });
    child.on('error', (error) => {
      this.fail(error);
    });
  }

  onNotification(method: string, handler: Handler): void {
    this.notificationHandlers.set(method, handler);
  }

  onRequest(method: string, handler: Handler): void {
    this.requestHandlers.set(method, handler);
  }

  request<T>(method: string, params: unknown, timeoutMs = 15_000): Promise<T> {
    if (this.closed) return Promise.reject(this.closed);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    if (!this.closed) this.write({ method, params });
  }

  kill(): void {
    this.fail(new Error('connection closed'));
    this.child.kill();
  }

  private write(message: Message): void {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message }), 'utf8');
    this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    this.child.stdin.write(body);
  }

  private receive(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n');
      if (headerEnd < 0) return;
      const length = Number(
        /Content-Length:\s*(\d+)/i.exec(this.buffer.subarray(0, headerEnd).toString())?.[1],
      );
      const start = headerEnd + 4;
      if (!Number.isFinite(length) || this.buffer.length < start + length) return;
      const message = JSON.parse(
        this.buffer.subarray(start, start + length).toString('utf8'),
      ) as Message;
      this.buffer = this.buffer.subarray(start + length);
      this.dispatch(message);
    }
  }

  private dispatch(message: Message): void {
    if (message.method !== undefined && message.id !== undefined) {
      const handler = this.requestHandlers.get(message.method);
      Promise.resolve(handler ? handler(message.params) : null).then(
        (result) => {
          this.write({ id: message.id!, result: result ?? null });
        },
        (error: unknown) => {
          this.write({ id: message.id!, error: { message: String(error) } });
        },
      );
      return;
    }
    if (message.method !== undefined) {
      this.notificationHandlers.get(message.method)?.(message.params);
      return;
    }
    const pending = typeof message.id === 'number' ? this.pending.get(message.id) : undefined;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(message.id as number);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message.result);
  }

  private fail(error: Error): void {
    if (this.closed) return;
    this.closed = error;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
  }
}
