// Client for the real Jev typed-decision model (TypeSafe), served by OpenRouter's decisions
// endpoint. Unlike a chat model, Jev is constrained to a fixed set of choices and returns a
// calibrated probability per choice — so callers get a typed answer, not text to parse. Every
// call is fail-open: any transport, HTTP or shape error resolves to null.
export interface JevCall {
  model: string;
  /** Base of the decisions API, e.g. https://openrouter.ai/api/alpha. */
  baseUrl: string;
  timeoutMs: number;
}

export interface ChoiceAnswer {
  choice: string;
  /** Confidence in the chosen option, 0–1. */
  confidence: number;
  /** Probability mass per offered choice. */
  probabilities: Record<string, number>;
}

/** The API key, from the environment. Absent when a Jev feature is enabled but not configured. */
export const jevKey = (): string | undefined => process.env.OPENROUTER_API_KEY;

/**
 * Ask Jev one multiple-choice question about `state`. `criteria` maps each allowed choice to a
 * short description of when it applies; the answer's `choice` is always one of its keys. Returns
 * null on any failure (fail-open) so callers keep their deterministic behaviour. Never throws.
 */
export async function decideChoice(
  call: JevCall,
  state: string,
  instructions: string,
  criteria: Record<string, string>,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ChoiceAnswer | null> {
  try {
    const response = await fetchImpl(`${call.baseUrl.replace(/\/$/, '')}/decisions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
        'x-title': 'yandecode',
      },
      body: JSON.stringify({
        model: call.model,
        state,
        questions: { verdict: { type: 'choice', instructions, criteria } },
      }),
      signal: AbortSignal.timeout(call.timeoutMs),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      answers?: { verdict?: { choice?: unknown; confidence?: unknown; probabilities?: unknown } };
    };
    const answer = data.answers?.verdict;
    if (
      !answer ||
      typeof answer.choice !== 'string' ||
      typeof answer.confidence !== 'number' ||
      !(answer.choice in criteria)
    ) {
      return null;
    }
    const probabilities =
      typeof answer.probabilities === 'object' && answer.probabilities !== null
        ? (answer.probabilities as Record<string, number>)
        : {};
    return { choice: answer.choice, confidence: answer.confidence, probabilities };
  } catch {
    return null;
  }
}
