import { createInterface } from 'node:readline/promises';

/** Terminal I/O behind an interface so commands are testable without a TTY. */
export interface Io {
  out(text: string): void;
  err(text: string): void;
  interactive: boolean;
  ask(question: string): Promise<string>;
}

export function processIo(): Io {
  return {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
    interactive: process.stdin.isTTY && process.stdout.isTTY,
    ask: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
}
