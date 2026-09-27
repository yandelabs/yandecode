// YandeCode demo: several modules working together on "investigate a failure and fix it",
// driven through the same MCP stdio interface Claude Code uses. No model or credentials needed.
// Usage: npm run build && node examples/demo/demo.mjs
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const bin = join(repo, 'packages', 'cli', 'dist', 'bin.js');
const project = mkdtempSync(join(tmpdir(), 'yc-demo-'));
cpSync(join(repo, 'examples', 'demo', 'project'), project, { recursive: true });
execFileSync('git', ['init', '-q'], { cwd: project });
const cli = (...args) =>
  execFileSync(process.execPath, [bin, ...args], { cwd: project, encoding: 'utf8' });

const banner = (text) => console.log(`\n\x1b[1m━━ ${text}\x1b[0m`);
banner('yandecode init --modules code,context,knowledge,quality,workflow');
console.log(cli('init', '--modules', 'code,context,knowledge,quality,workflow'));

const server = spawn(process.execPath, [bin, 'mcp', 'serve'], { cwd: project });
const waiting = new Map();
let buffer = '';
server.stdout.on('data', (chunk) => {
  buffer += chunk;
  for (let i; (i = buffer.indexOf('\n')) >= 0; buffer = buffer.slice(i + 1)) {
    const message = JSON.parse(buffer.slice(0, i));
    waiting.get(message.id)?.(message);
  }
});
let nextId = 0;
const rpc = (method, params) =>
  new Promise((resolve) => {
    waiting.set(++nextId, resolve);
    server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: nextId, method, params })}\n`);
  });
const tool = async (name, args) => {
  banner(`${name} ${JSON.stringify(args)}`);
  const { result } = await rpc('tools/call', { name, arguments: args });
  const text = result.content[0].text;
  console.log(text);
  return text;
};

await rpc('initialize', {
  protocolVersion: '2025-06-18',
  capabilities: {},
  clientInfo: { name: 'demo', version: '0' },
});
server.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

// workflow: a resumable change folder with one task and its acceptance criterion
await tool('work_new', {
  title: 'Fix cart total',
  why: 'Customers are undercharged for multi-quantity lines.',
});
writeFileSync(
  join(project, 'docs/changes/fix-cart-total/tasks.md'),
  '- [ ] T1 cartTotal multiplies price by quantity\n  - AC: npm test passes\n',
);
await tool('work_next', { id: 'fix-cart-total' });

// quality: run the project checks, see only the failure
await tool('quality_check', {});

// code: locate the code without reading whole files
await tool('code_search', { query: 'cart total price quantity' });
await tool('code_definition', { name_path: 'cartTotal' });

// the fix (what the agent would do with its Edit tool)
const file = join(project, 'src/cart.js');
writeFileSync(
  file,
  readFileSync(file, 'utf8').replace('sum + line.price,', 'sum + line.price * line.quantity,'),
);
banner('edit src/cart.js: sum + line.price → sum + line.price * line.quantity');

// verify, record evidence, remember the root cause
await tool('quality_check', {});
await tool('work_check', { id: 'fix-cart-total', task_id: 'T1', evidence: 'npm test: 2 passed' });
await tool('memory_write', {
  title: 'Cart totals must multiply price by quantity',
  body: 'cartTotal summed unit prices only, undercharging multi-quantity lines. Test: test/cart.test.js.',
  kind: 'failure',
  sources: ['src/cart.js:2', 'test/cart.test.js'],
});

// context: a noisy command stays out of the conversation but remains searchable
await tool('ctx_run', {
  command: 'git log --stat; node --test --test-reporter=spec',
  intent: 'test results',
});

// knowledge: a later session finds the lesson by asking in its own words
await tool('knowledge_search', { query: 'why was the cart total wrong' });
await tool('work_status', {});

server.kill();
banner(`done — project left at ${project}`);
