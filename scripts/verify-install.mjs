// Clean-environment installation check (T-30). Packs the CLI, installs it into an empty prefix
// with an empty HOME and npm cache, then exercises it on a copy of fixtures/repo-auth:
//   init (all modules) → status → doctor → hook latency → MCP handshake + tool calls.
// Usage: npm run build && node scripts/verify-install.mjs [--keep]
import { execFileSync, spawn } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const work = mkdtempSync(join(tmpdir(), 'yc-install-'));
const home = join(work, 'home');
const prefix = join(work, 'prefix');
const project = join(work, 'project');
mkdirSync(home);
const env = {
  // The real node/npm directory first: version-manager shims (asdf, nvm) depend on the real HOME.
  PATH: `${join(prefix, 'bin')}:${dirname(process.execPath)}:/usr/bin:/bin`,
  HOME: home,
  npm_config_cache: join(work, 'npm-cache'),
  npm_config_userconfig: join(home, '.npmrc'),
  YANDECODE_CACHE_DIR: join(home, '.cache', 'yandecode'),
};
const run = (command, args, cwd = work, input) =>
  execFileSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
const step = (title) => console.log(`\n=== ${title}`);
const results = {};

step('pack');
const tarball = run('npm', ['pack', '--pack-destination', work], join(repo, 'packages', 'cli'))
  .trim()
  .split('\n')
  .pop();
console.log(tarball);

step('install into an empty prefix/HOME/npm cache');
let t = Date.now();
run('npm', ['install', '-g', '--no-audit', '--no-fund', '--prefix', prefix, join(work, tarball)]);
results.installSeconds = (Date.now() - t) / 1000;
console.log(`installed in ${results.installSeconds}s:`, run('yandecode', ['--version']).trim());

step('init --all on a fresh git repo');
cpSync(join(repo, 'fixtures', 'repo-auth'), project, { recursive: true });
run('git', ['init', '-q'], project);
console.log(run('yandecode', ['init', '--all'], project));
console.log(run('yandecode', ['status'], project));

step('doctor');
try {
  console.log(run('yandecode', ['doctor'], project));
  results.doctor = 'ok';
} catch (error) {
  console.log(error.stdout);
  results.doctor = 'failed';
}

step('hook latency with every module enabled (PreToolUse Bash, 10 runs)');
const input = JSON.stringify({
  session_id: 's',
  cwd: project,
  tool_name: 'Bash',
  tool_input: { command: 'ls' },
});
const samples = [];
for (let i = 0; i < 10; i++) {
  t = process.hrtime.bigint();
  run('yandecode', ['hook', 'PreToolUse'], project, input);
  samples.push(Number(process.hrtime.bigint() - t) / 1e6);
}
samples.sort((a, b) => a - b);
results.hookP50Ms = Math.round(samples[5]);
results.hookP90Ms = Math.round(samples[9]);
console.log(`p50 ${results.hookP50Ms} ms, max ${results.hookP90Ms} ms`);

step('MCP stdio handshake and tool calls');
results.mcp = await new Promise((resolve, reject) => {
  const child = spawn('yandecode', ['mcp', 'serve'], { cwd: project, env });
  const pending = new Map();
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const message = JSON.parse(buffer.slice(0, newline));
      buffer = buffer.slice(newline + 1);
      pending.get(message.id)?.(message);
    }
  });
  let id = 0;
  const call = (method, params) =>
    new Promise((res) => {
      pending.set(++id, res);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  (async () => {
    await call('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'verify', version: '0' },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
    const tools = (await call('tools/list', {})).result.tools.map((tool) => tool.name);
    const search = (
      await call('tools/call', { name: 'code_search', arguments: { query: 'loginWithSso' } })
    ).result;
    const memory = (
      await call('tools/call', {
        name: 'memory_write',
        arguments: {
          title: 'Install check memory',
          body: 'Written by verify-install.',
          kind: 'note',
        },
      })
    ).result;
    const recall = (
      await call('tools/call', { name: 'knowledge_search', arguments: { query: 'install check' } })
    ).result;
    child.kill();
    resolve({
      toolCount: tools.length,
      tools,
      codeSearchFound: search.content[0].text.includes('AuthService/loginWithSso'),
      memoryRoundTrip: !memory.isError && recall.content[0].text.includes('Install check memory'),
    });
  })().catch(reject);
});
console.log(results.mcp);

step('uninstall');
console.log(run('yandecode', ['uninstall', '--purge'], project));
results.leftovers = readdirSync(project).filter((f) =>
  ['.yandecode', 'yandecode.json'].includes(f),
);

console.log(`\nRESULT ${JSON.stringify(results)}`);
const ok =
  results.doctor === 'ok' &&
  results.mcp.codeSearchFound &&
  results.mcp.memoryRoundTrip &&
  results.leftovers.length === 0;
if (!process.argv.includes('--keep')) rmSync(work, { recursive: true, force: true });
else console.log(`kept ${work}`);
process.exit(ok ? 0 : 1);
