import { HOOK_EVENTS, type HookEvent, type HookInput } from '@cli/modules/contract';
import { enabledModules, moduleContext, openWorkspace } from '@cli/modules/host';
import { dispatchHook } from './dispatch';

/** Must stay below the `timeout` written into settings.json (5 s for tool events, 10 s otherwise). */
const BUDGET_MS: Partial<Record<HookEvent, number>> = { PreToolUse: 1_500, PostToolUse: 2_500 };

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

function parseInput(text: string): HookInput {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === 'object' && value !== null ? (value as HookInput) : {};
  } catch {
    return {};
  }
}

/**
 * `yandecode hook <Event>` — invoked by Claude Code. Always exits 0: a broken or slow module must
 * never block the user's session (fail-open, ADR-016/ADR-022). Decisions travel as JSON on stdout.
 */
export async function runHookCli(event: string): Promise<number> {
  if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
    process.stderr.write(`yandecode: unknown hook event "${event}"\n`);
    return 0;
  }
  const input = parseInput(await readStdin());
  try {
    const ws = openWorkspace(typeof input.cwd === 'string' ? input.cwd : process.cwd());
    if (!ws) return 0;
    const modules = enabledModules(ws);
    const result = await dispatchHook({
      event: event as HookEvent,
      input,
      modules,
      contextFor: (m) => moduleContext(ws, m),
      timeoutMs: BUDGET_MS[event as HookEvent] ?? 8_000,
    });
    for (const failure of result.failures) {
      const module = modules.find((m) => m.id === failure.module);
      if (module) moduleContext(ws, module).log('hook_failure', { event, error: failure.error });
    }
    if (result.stdout) process.stdout.write(result.stdout);
  } catch (error) {
    process.stderr.write(`yandecode hook ${event}: ${(error as Error).message}\n`);
  }
  return 0;
}
