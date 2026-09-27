#!/usr/bin/env node
export {};
// Hooks run on every tool call, so they skip commander and every unrelated command (ADR-025).
const [command, argument] = process.argv.slice(2);

if (command === 'hook') {
  const { runHookCli } = await import('@cli/hooks/entry');
  const code = await runHookCli(argument ?? '');
  // Flush stdout, then exit even if a module left handles open (e.g. a language server).
  process.stdout.write('', () => process.exit(code));
} else {
  const { main } = await import('@cli/cli');
  await main(process.argv);
}
