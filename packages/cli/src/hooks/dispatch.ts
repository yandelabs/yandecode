import type {
  HookEvent,
  HookInput,
  HookResult,
  ModuleContext,
  ModuleDefinition,
} from '@cli/modules/contract';

/** Claude Code replaces hook stdout above 10 000 chars with a stub; stay well below it. */
export const CONTEXT_BUDGET_CHARS = 8_000;

const CONTEXT_EVENTS: ReadonlySet<HookEvent> = new Set([
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
]);

export interface DispatchOptions {
  event: HookEvent;
  input: HookInput;
  /** Enabled modules, in dependency order. */
  modules: readonly ModuleDefinition[];
  contextFor: (module: ModuleDefinition) => ModuleContext;
  timeoutMs: number;
}

export interface DispatchFailure {
  module: string;
  error: string;
}

export interface DispatchResult {
  stdout: string;
  failures: DispatchFailure[];
}

function matches(matcher: string | undefined, toolName: string | undefined): boolean {
  if (matcher === undefined || matcher === '' || matcher === '*') return true;
  if (toolName === undefined) return false;
  return new RegExp(`^(?:${matcher})$`).test(toolName);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`timed out after ${ms} ms`));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

function fitContext(blocks: { module: string; text: string }[]): string {
  const kept: string[] = [];
  const dropped: string[] = [];
  let used = 0;
  const noteReserve = 200;
  for (const block of blocks) {
    const cost = block.text.length + (kept.length > 0 ? 2 : 0);
    if (used + cost <= CONTEXT_BUDGET_CHARS - noteReserve) {
      kept.push(block.text);
      used += cost;
    } else if (kept.length === 0) {
      const room = CONTEXT_BUDGET_CHARS - noteReserve;
      kept.push(
        `${block.text.slice(0, room)}\n[yandecode: truncated ${block.text.length - room} chars from ${block.module}]`,
      );
      used = CONTEXT_BUDGET_CHARS;
    } else {
      dropped.push(block.module);
    }
  }
  if (dropped.length > 0) {
    kept.push(
      `[yandecode: ${dropped.length} context block(s) omitted to fit the hook budget: ${dropped.join(', ')}]`,
    );
  }
  return kept.join('\n\n');
}

/**
 * Runs every enabled module subscribed to `event` (and matching the tool, for tool events),
 * each isolated: a module that throws or exceeds the time budget is recorded and skipped, never
 * blocking Claude Code (fail-open). Decisions merge as deny > context > none.
 */
export async function dispatchHook(options: DispatchOptions): Promise<DispatchResult> {
  const { event, input } = options;
  const subscribed = options.modules.filter((m) =>
    m.hooks.some((b) => b.event === event && matches(b.matcher, input.tool_name)),
  );

  const failures: DispatchFailure[] = [];
  const results = await Promise.all(
    subscribed.map(async (module): Promise<{ module: string; result: HookResult } | null> => {
      try {
        const run = async (): Promise<HookResult> => {
          const runtime = await module.load();
          const handler = runtime.hooks?.[event];
          if (!handler) return { kind: 'none' };
          return handler(input, options.contextFor(module));
        };
        return { module: module.id, result: await withTimeout(run(), options.timeoutMs) };
      } catch (error) {
        failures.push({
          module: module.id,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }),
  );

  const denies: string[] = [];
  const contexts: { module: string; text: string }[] = [];
  for (const entry of results) {
    if (!entry) continue;
    if (entry.result.kind === 'deny' && event === 'PreToolUse') {
      denies.push(`[${entry.module}] ${entry.result.reason}`);
    } else if (entry.result.kind === 'context' && entry.result.text.trim() !== '') {
      contexts.push({ module: entry.module, text: entry.result.text });
    }
  }

  if (denies.length > 0) {
    return {
      failures,
      stdout: JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          permissionDecision: 'deny',
          permissionDecisionReason: denies.join('\n'),
        },
      }),
    };
  }
  if (contexts.length > 0 && CONTEXT_EVENTS.has(event)) {
    return {
      failures,
      stdout: JSON.stringify({
        hookSpecificOutput: { hookEventName: event, additionalContext: fitContext(contexts) },
      }),
    };
  }
  return { stdout: '', failures };
}
