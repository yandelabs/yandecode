/**
 * Lines that usually explain a failure. No leading \b: camelCase names such as
 * `AssertionError` or `TypeError` must match too.
 */
const SIGNAL =
  /(errors?|exception|fail(ed|ure|ing|s)?|panic|traceback|fatal|assert(ion)?|denied|refused|timed? ?out)\b|✗|×/i;
const MAX_LINE_CHARS = 300;

export interface Digest {
  text: string;
  omittedLines: number;
}

export interface DigestOptions {
  maxChars: number;
  /** Extra line numbers (0-based) to keep, e.g. search hits for the caller's intent. */
  focus?: readonly number[];
}

interface Plan {
  head: number;
  signal: number;
  tail: number;
}

function numbered(lines: readonly string[], index: number): string {
  const line = lines[index] ?? '';
  const clipped = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}…` : line;
  return `${index + 1}: ${clipped}`;
}

function render(
  lines: readonly string[],
  signals: readonly number[],
  plan: Plan,
): { text: string; shown: number } {
  const head = Array.from({ length: Math.min(plan.head, lines.length) }, (_, i) => i);
  const tailStart = Math.max(head.length, lines.length - plan.tail);
  const tail = Array.from({ length: lines.length - tailStart }, (_, i) => tailStart + i);
  const edges = new Set([...head, ...tail]);
  const middle = signals.filter((i) => !edges.has(i)).slice(0, plan.signal);
  const blocks = [`[lines 1-${head.length}]`, ...head.map((i) => numbered(lines, i))];
  if (middle.length > 0) {
    blocks.push(
      `[${middle.length} notable line(s) in between]`,
      ...middle.map((i) => numbered(lines, i)),
    );
  }
  if (tail.length > 0) {
    blocks.push(`[lines ${tailStart + 1}-${lines.length}]`, ...tail.map((i) => numbered(lines, i)));
  }
  return { text: blocks.join('\n'), shown: head.length + middle.length + tail.length };
}

function shrink(plan: Plan): Plan | null {
  if (plan.signal > 4) return { ...plan, signal: Math.ceil(plan.signal / 2) };
  if (plan.tail > 8) return { ...plan, tail: plan.tail - 4 };
  if (plan.head > 3) return { ...plan, head: plan.head - 2 };
  if (plan.signal > 0) return { ...plan, signal: plan.signal - 1 };
  if (plan.tail > 2) return { ...plan, tail: plan.tail - 2 };
  return null;
}

/**
 * Condenses long output to what usually matters — the start, the end, and lines that look like
 * failures (plus caller-chosen focus lines) — numbered so the caller can fetch exact ranges later.
 * Output that already fits is returned verbatim: a digest must never cost more than the original.
 */
export function digest(output: string, options: DigestOptions): Digest {
  if (output.length <= options.maxChars) return { text: output, omittedLines: 0 };
  const lines = output.split('\n');
  const signals = [
    ...new Set([
      ...(options.focus ?? []),
      ...lines.flatMap((line, i) => (SIGNAL.test(line) ? [i] : [])),
    ]),
  ].sort((a, b) => a - b);
  let plan: Plan | null = { head: 10, signal: 40, tail: 30 };
  let result = render(lines, signals, plan);
  while (result.text.length > options.maxChars && (plan = shrink(plan)) !== null) {
    result = render(lines, signals, plan);
  }
  const text =
    result.text.length > options.maxChars
      ? `${result.text.slice(0, options.maxChars - 1)}…`
      : result.text;
  return { text, omittedLines: lines.length - result.shown };
}
