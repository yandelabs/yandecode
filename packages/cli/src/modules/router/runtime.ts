import type { HookResult, ModuleContext, ModuleRuntime } from '@cli/modules/contract';
import { parseSettings } from '@cli/modules/host';
import { MODULES } from '@cli/modules/registry';
import { resolveEnabled } from '@cli/modules/resolve';
import { decideChoice, jevKey } from '@cli/shared/jev';
import { routerSettings } from './definition';

interface Option {
  intent: string;
  use: string;
}

/** The routing rules of every enabled module (except this one) become Jev's choices. */
export function routableOptions(ctx: Pick<ModuleContext, 'config'>): Option[] {
  const enabled = new Set(resolveEnabled(MODULES, ctx.config.modules));
  return MODULES.filter((m) => m.id !== 'router' && enabled.has(m.id)).flatMap((m) =>
    (m.routing ?? []).map((r) => ({ intent: r.intent, use: r.use })),
  );
}

/** Choice keys `o0..oN` mapped to the intent that describes each tool, plus a `none` escape. */
export function buildCriteria(options: Option[]): Record<string, string> {
  const criteria: Record<string, string> = {};
  options.forEach((option, i) => {
    criteria[`o${i}`] = option.intent;
  });
  criteria.none = 'None of the tools fit: a plain edit, chit-chat, or an unclear ask.';
  return criteria;
}

async function onUserPromptSubmit(
  input: { prompt?: string },
  ctx: ModuleContext,
): Promise<HookResult> {
  const settings = parseSettings('router', routerSettings, ctx.settings);
  const apiKey = jevKey();
  const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
  if (!apiKey || prompt.length < settings.minPromptChars) return { kind: 'none' };
  const options = routableOptions(ctx);
  if (options.length === 0) return { kind: 'none' };

  const answer = await decideChoice(
    settings,
    prompt,
    "Which tool best fits the user's current request?",
    buildCriteria(options),
    apiKey,
  );
  // Fail-open: a missing key, timeout, malformed answer, `none` or low confidence adds no hint.
  if (!answer || answer.choice === 'none' || answer.confidence < settings.minConfidence)
    return { kind: 'none' };
  const option = options[Number(answer.choice.slice(1))];
  if (!option) return { kind: 'none' };
  ctx.log('routed', { use: option.use, confidence: answer.confidence });
  return {
    kind: 'context',
    text: `yandecode: this turn looks like «${option.intent}» — prefer \`${option.use}\`. If its schema is not loaded, ToolSearch(select) it instead of falling back to Bash.`,
  };
}

export const runtime: ModuleRuntime = {
  hooks: { UserPromptSubmit: onUserPromptSubmit },
};
