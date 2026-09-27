// One headless Claude Code session and its metrics, shared by the A/B harnesses.
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const parseEvents = (out) =>
  out
    .split('\n')
    .filter((l) => l.startsWith('{'))
    .map((l) => JSON.parse(l));

function toolCounts(events) {
  const tools = {};
  for (const e of events.filter((e) => e.type === 'assistant')) {
    for (const c of e.message.content.filter((c) => c.type === 'tool_use')) {
      tools[c.name] = (tools[c.name] ?? 0) + 1;
    }
  }
  return tools;
}

/** Fields of the final `result` event (null when the session died before emitting it). */
function resultFields(final) {
  if (!final)
    return {
      subtype: null,
      isError: true,
      durationMs: null,
      turns: null,
      costUsdEquivalent: null,
      usage: null,
    };
  return {
    subtype: final.subtype,
    isError: final.is_error,
    durationMs: final.duration_ms,
    turns: final.num_turns,
    costUsdEquivalent: final.total_cost_usd,
    usage: final.usage,
  };
}

/** Metrics of one agent session from its stream-json output. */
function summarize(out, err, exitCode, wallMs, timeoutMs) {
  const events = parseEvents(out);
  const final = events.find((e) => e.type === 'result');
  const tools = toolCounts(events);
  const sum = (entries) => entries.reduce((total, [, n]) => total + n, 0);
  return {
    exitCode,
    timedOut: wallMs >= timeoutMs,
    rateLimited:
      /usage limit|rate.?limit|limit reached/i.test(`${JSON.stringify(final)}\n${err}`) &&
      final?.is_error !== false,
    wallMs,
    ...resultFields(final),
    toolCalls: tools,
    totalToolCalls: sum(Object.entries(tools)),
    yandecodeToolCalls: sum(
      Object.entries(tools).filter(([n]) => n.startsWith('mcp__yandecode__')),
    ),
  };
}

/**
 * Runs `claude -p` in `cwd` with only the project's settings and the given MCP config, saves the
 * stream-json transcript and resolves to the session's metrics.
 */
export function runAgent({ cwd, env, prompt, model, budget, mcpConfig, transcript, timeoutMs }) {
  const args = [
    '-p',
    prompt,
    '--model',
    model,
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'bypassPermissions',
    '--setting-sources',
    'project',
    '--strict-mcp-config',
    '--mcp-config',
    mcpConfig,
    '--max-budget-usd',
    budget,
  ];
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn('claude', args, { cwd, env });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      writeFileSync(transcript, out);
      if (err.trim()) writeFileSync(`${transcript}.stderr`, err);
      done(summarize(out, err, code, Date.now() - started, timeoutMs));
    });
  });
}
