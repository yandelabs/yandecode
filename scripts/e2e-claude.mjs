// End-to-end check with the real Claude Code CLI (T-32). Costs a few cents of model usage.
// Installs the packed CLI into an isolated prefix, runs `init --all` on a copy of
// fixtures/repo-auth, then two separate `claude -p` sessions:
//   1. navigate with code_search, run a command through ctx_run, record a decision (memory_write);
//   2. a fresh process must answer from memory injected at SessionStart.
// Transcripts and a verdict go to benchmarks/results/e2e-<date>.json.
// Usage: npm run build && node scripts/e2e-claude.mjs [--model <id>]
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = fileURLToPath(new URL('..', import.meta.url));
const modelFlag = process.argv.indexOf('--model');
const model = modelFlag > 0 ? process.argv[modelFlag + 1] : 'claude-haiku-4-5-20251001';
const work = mkdtempSync(join(tmpdir(), 'yc-e2e-'));
const prefix = join(work, 'prefix');
const project = join(work, 'project');
const claude = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
// The packed yandecode must win over any other install on PATH (hooks call `yandecode`).
const env = {
  ...process.env,
  PATH: `${join(prefix, 'bin')}:${dirname(process.execPath)}:${process.env.PATH}`,
};
const run = (command, args, cwd = work) =>
  execFileSync(command, args, { cwd, env, encoding: 'utf8' });

const tarball = run('npm', ['pack', '--pack-destination', work], join(repo, 'packages', 'cli'))
  .trim()
  .split('\n')
  .pop();
run('npm', [
  'install',
  '-g',
  '--silent',
  '--no-audit',
  '--no-fund',
  '--prefix',
  prefix,
  join(work, tarball),
]);
cpSync(join(repo, 'fixtures', 'repo-auth'), project, { recursive: true });
run('git', ['init', '-q'], project);
run('yandecode', ['init', '--all'], project);
console.log(
  `project: ${project}\nyandecode: ${run('which', ['yandecode']).trim()} ${run('yandecode', ['--version']).trim()}`,
);

function session(prompt) {
  const result = spawnSync(
    claude,
    [
      '-p',
      prompt,
      '--model',
      model,
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'bypassPermissions',
      '--mcp-config',
      join(project, '.mcp.json'),
    ],
    { cwd: project, env, encoding: 'utf8', timeout: 600_000, maxBuffer: 64 * 1024 * 1024 },
  );
  const events = result.stdout
    .split('\n')
    .filter((line) => line.trim().startsWith('{'))
    .map((line) => JSON.parse(line));
  const tools = events
    .filter((e) => e.type === 'assistant')
    .flatMap((e) => e.message.content.filter((c) => c.type === 'tool_use').map((c) => c.name));
  const final = events.find((e) => e.type === 'result');
  const init = events.find((e) => e.type === 'system' && e.subtype === 'init');
  return {
    exitCode: result.status,
    // Only our server: the user's other MCP servers are private and irrelevant here.
    mcpServers: (init?.mcp_servers ?? []).filter((s) => s.name === 'yandecode'),
    yandecodeToolsAvailable: (init?.tools ?? []).filter((t) => t.startsWith('mcp__yandecode__'))
      .length,
    toolsCalled: tools,
    answer: final?.result ?? '',
    costUsd: final?.total_cost_usd ?? null,
  };
}

const first = session(
  [
    'Use the yandecode MCP tools for this task, not Grep/Glob/Read.',
    '1. Find the function that creates or finds a user during SSO login (use code_search) and name its file.',
    '2. Run `ls -R src` through ctx_run.',
    '3. Record a durable decision with memory_write: title "Sessions use opaque tokens, not JWT", kind "decision",',
    '   body "Logout must revoke immediately; see the ADR.", sources ["docs/adr/001-opaque-tokens.md"].',
    'Reply with the file from step 1 and the memory id.',
  ].join('\n'),
);
console.log('\nsession 1:', JSON.stringify(first, null, 2));

const second = session(
  'Without calling any tools, answer from the project context you were given at startup: what did this project decide about session tokens, and what is the id of that memory?',
);
console.log('\nsession 2:', JSON.stringify(second, null, 2));

const memoryDir = join(project, '.yandecode', 'memory');
const memoryFiles = existsSync(memoryDir)
  ? readdirSync(memoryDir).filter((f) => f.endsWith('.md'))
  : [];
const sessionSummaries = memoryFiles.filter((f) => /session-/.test(f)).length;
const checks = {
  mcpConnected: first.mcpServers.some((s) => s.name === 'yandecode' && s.status === 'connected'),
  toolsDiscovered: first.yandecodeToolsAvailable,
  usedCodeSearch: first.toolsCalled.includes('mcp__yandecode__code_search'),
  usedCtxRun: first.toolsCalled.includes('mcp__yandecode__ctx_run'),
  usedMemoryWrite: first.toolsCalled.includes('mcp__yandecode__memory_write'),
  foundUserRepository: /UserRepository/.test(first.answer),
  decisionFileWritten: memoryFiles.some((f) => f.includes('opaque-tokens')),
  sessionSummaryFromHooks: sessionSummaries > 0,
  recalledInNewSession: /opaque/i.test(second.answer) && second.toolsCalled.length === 0,
};
const out = join(
  repo,
  'benchmarks',
  'results',
  `e2e-${new Date().toISOString().slice(0, 10)}.json`,
);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(
  out,
  `${JSON.stringify({ model, claudeVersion: run(claude, ['--version']).trim(), checks, sessions: [first, second], memoryFiles, managedMemory: memoryFiles.map((f) => readFileSync(join(memoryDir, f), 'utf8')) }, null, 2)}\n`,
);
console.log('\nchecks', checks, `\nwritten ${out}`);
process.exit(
  Object.values(checks).every((v) => v === true || (typeof v === 'number' && v > 0)) ? 0 : 1,
);
