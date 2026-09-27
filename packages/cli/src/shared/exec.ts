import { spawn } from 'node:child_process';

export interface ExecResult {
  output: string;
  exitCode: number | null;
  durationMs: number;
  timedOut: boolean;
  truncatedBytes: number;
}

/**
 * Runs a shell command capturing stdout and stderr interleaved in arrival order, with a byte cap
 * (the rest is counted, not kept) and a timeout that escalates SIGTERM → SIGKILL.
 */
export function execShell(
  command: string,
  options: { cwd: string; timeoutMs: number; maxBytes: number },
): Promise<ExecResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    // Own process group (POSIX), so a timeout kills the shell *and* everything it started;
    // killing only the shell leaves children holding the pipes open.
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    const killTree = (signal: NodeJS.Signals): void => {
      try {
        if (process.platform === 'win32' || child.pid === undefined) child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        // Already gone.
      }
    };
    const chunks: Buffer[] = [];
    let kept = 0;
    let truncatedBytes = 0;
    let timedOut = false;
    const collect = (chunk: Buffer): void => {
      const room = options.maxBytes - kept;
      if (room > 0) {
        const part = chunk.length <= room ? chunk : chunk.subarray(0, room);
        chunks.push(part);
        kept += part.length;
      }
      truncatedBytes += Math.max(0, chunk.length - Math.max(0, room));
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree('SIGTERM');
      setTimeout(() => {
        killTree('SIGKILL');
      }, 2_000).unref();
    }, options.timeoutMs);
    const finish = (exitCode: number | null, extra = ''): void => {
      clearTimeout(timer);
      resolve({
        output: Buffer.concat(chunks).toString('utf8') + extra,
        exitCode,
        durationMs: Date.now() - started,
        timedOut,
        truncatedBytes,
      });
    };
    child.on('error', (error) => {
      finish(null, `\n[failed to start: ${error.message}]`);
    });
    child.on('close', (code) => {
      finish(code);
    });
  });
}
