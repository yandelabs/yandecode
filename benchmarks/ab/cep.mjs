// A/B benchmark on a real Go service (cep-api): Claude Code performs a small task — fixing a
// planted bug, adding a feature, or a refactor — with YandeCode (arm A) and without (arm B),
// from the same base, prompt and model. Success is judged by hidden Go tests the agent never
// sees, plus the package's existing tests staying green.
//
// The base (`ab-base`) is a frozen snapshot of the cep-api working tree, copied into <work> and
// committed there once; the user's repo is never touched. Runs are sequential and resumable.
//
// Usage:
//   node benchmarks/ab/cep.mjs --source ~/workspace/projects/cep-api [--model claude-sonnet-5] \
//     [--budget 3] [--tasks T1,T2,T3] [--arms B,A] [--work ~/.cache/yandecode-cep] [--gold]
import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runAgent } from './agent.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const suiteDir = dirname(fileURLToPath(import.meta.url)) + '/cep';
const suite = JSON.parse(readFileSync(join(suiteDir, 'tasks.json'), 'utf8'));
const source = resolve(arg('source', join(homedir(), 'workspace', 'projects', 'cep-api')));
const model = arg('model', 'claude-sonnet-5');
const budget = arg('budget', '3');
const arms = arg('arms', 'B,A').split(',');
const wanted = arg('tasks', suite.tasks.map((t) => t.id).join(',')).split(',');
const work = resolve(arg('work', join(homedir(), '.cache', 'yandecode-cep')));
const gold = process.argv.includes('--gold');
const repo = join(work, suite.repo);
const results = join(work, gold ? 'results-gold.json' : 'results.json');
const env = { ...process.env, TMPDIR: join(work, 'tmp') };
mkdirSync(env.TMPDIR, { recursive: true });
const AGENT_TIMEOUT_MS = 20 * 60_000;
/** Files the harness or YandeCode writes; never part of the agent's task diff. */
const HARNESS_PATHS = ['.yandecode', '.claude', '.mcp.json', 'yandecode.json', 'CLAUDE.md'];

const log = (text) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${text}`);
const sh = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { cwd: repo, env, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, ...opts });
const git = (...args) => {
  const r = sh('git', args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};

/** Freeze the source working tree (uncommitted restructure and all) as an isolated ab-base. */
function prepareBase() {
  if (existsSync(join(repo, '.git'))) return;
  mkdirSync(repo, { recursive: true });
  cpSync(source, repo, {
    recursive: true,
    filter: (src) => !/\/(\.git|bench|node_modules)$/.test(src),
  });
  git('init', '-q');
  const toolVersions = join(repo, '.tool-versions');
  const pins = existsSync(toolVersions) ? readFileSync(toolVersions, 'utf8') : '';
  // asdf shims refuse to run a tool the directory does not pin.
  if (!/^golang /m.test(pins) || !/^nodejs /m.test(pins))
    writeFileSync(toolVersions, `golang 1.26.4\nnodejs ${process.versions.node}\n`);
  git('add', '-A');
  git('-c', 'user.email=ab@x', '-c', 'user.name=ab', 'commit', '-qm', 'ab-base snapshot');
  git('tag', 'ab-base');
}

function reset() {
  git('reset', '-q', '--hard', 'ab-base');
  git('clean', '-qfd');
  for (const path of HARNESS_PATHS) rmSync(join(repo, path), { recursive: true, force: true });
}

function setupArm(armId) {
  const mcp = join(work, `mcp-${armId}.json`);
  if (!armId.startsWith('A')) {
    writeFileSync(mcp, JSON.stringify({ mcpServers: {} }));
    return mcp;
  }
  execFileSync('yandecode', ['init', '--all'], { cwd: repo, env, stdio: 'ignore' });
  return join(repo, '.mcp.json');
}

/**
 * Judge behaviour with our tests, not the agent's: drop every test file in the touched packages
 * (agent-added or agent-edited), restore the ones present at ab-base, then drop in the hidden
 * tests. Without this the agent's own `TestX` can collide with a hidden `TestX` in the package.
 */
function placeHiddenTests(task) {
  for (const pkg of task.testPackages) {
    const abs = join(repo, pkg);
    for (const f of readdirSync(abs).filter((f) => f.endsWith('_test.go'))) rmSync(join(abs, f));
    const baseTests = git('ls-tree', '-r', '--name-only', 'ab-base', pkg)
      .split('\n')
      .filter((f) => f.endsWith('_test.go'));
    if (baseTests.length > 0) git('checkout', 'ab-base', '--', ...baseTests);
  }
  const dir = join(suiteDir, 'hidden', task.id);
  for (const file of readdirSync(dir))
    cpSync(join(dir, file), join(repo, task.testPackages[0], file));
}

function goTest(packages) {
  const r = sh('go', ['test', ...packages.map((p) => `./${p}/`)], { timeout: 10 * 60_000 });
  return {
    passed: r.status === 0,
    tail: `${r.stdout}${r.stderr}`.trim().split('\n').slice(-3).join(' | '),
  };
}

/** Save the agent's diff, then judge it with the hidden tests plus the touched packages. */
function evaluate(task, armId) {
  git('add', '-A');
  const excluded = [...HARNESS_PATHS, '.gitignore'].map((p) => `:!${p}`);
  const patch = sh('git', ['diff', '--cached', 'ab-base', '--', '.', ...excluded]).stdout;
  writeFileSync(join(work, `patch-${task.id}-${armId}.diff`), patch);
  placeHiddenTests(task);
  const hidden = goTest(task.testPackages.slice(0, 1));
  const regression = goTest(task.testPackages);
  return {
    patchLines: patch.split('\n').filter((l) => /^[+-][^+-]/.test(l)).length,
    resolved: hidden.passed && regression.passed,
    hidden,
    regression,
  };
}

/** The main loop has already applied any setup patch; here we add the reference fix. */
function applyGold(task) {
  if (task.kind === 'bug') git('apply', '-R', join(suiteDir, task.setup));
  else git('apply', join(suiteDir, 'gold', `${task.id}.patch`));
  return { gold: true, rateLimited: false, yandecodeToolCalls: 0, wallMs: 0 };
}

prepareBase();
const store = existsSync(results) ? JSON.parse(readFileSync(results, 'utf8')) : { model, runs: [] };

/** --reeval: re-judge each saved patch with the current evaluate() (no model calls). */
if (process.argv.includes('--reeval')) {
  for (const run of store.runs.filter((r) => r.outcome)) {
    const task = suite.tasks.find((t) => t.id === run.task);
    // The saved patch is the net diff from pristine ab-base, so it already reflects the setup.
    const patch = join(work, `patch-${run.task}-${run.arm}.diff`);
    reset();
    if (readFileSync(patch, 'utf8').trim()) git('apply', patch);
    run.outcome = evaluate(task, run.arm);
    writeFileSync(results, JSON.stringify(store, null, 2));
    log(
      `${run.task} arm ${run.arm}: re-judged ${run.outcome.resolved ? 'RESOLVED' : 'not resolved'}`,
    );
  }
  reset();
  process.exit(0);
}

for (const id of wanted) {
  const task = suite.tasks.find((t) => t.id === id);
  for (const armId of arms) {
    if (store.runs.some((r) => r.task === id && r.arm === armId && !r.agent.rateLimited)) continue;
    log(`${id} (${task.kind}) arm ${armId}: start`);
    reset();
    if (task.setup) git('apply', join(suiteDir, task.setup));
    const mcpConfig = setupArm(armId);
    const agent = gold
      ? applyGold(task)
      : await runAgent({
          cwd: repo,
          env,
          prompt: `You are working in the cep-api Go service (module ${suite.module}, this directory). ${task.prompt} Work autonomously and do not ask questions. Run \`go test ./...\` to check your work.`,
          model,
          budget,
          mcpConfig,
          transcript: join(work, `transcript-${id}-${armId}.jsonl`),
          timeoutMs: AGENT_TIMEOUT_MS,
        });
    store.runs = store.runs.filter((r) => !(r.task === id && r.arm === armId));
    if (agent.rateLimited) {
      store.runs.push({ task: id, arm: armId, model, agent });
      writeFileSync(results, JSON.stringify(store, null, 2));
      log(`${id} arm ${armId}: usage limit reached — rerun later to resume`);
      process.exit(2);
    }
    const outcome = evaluate(task, armId);
    store.runs.push({ task: id, arm: armId, model, agent, outcome });
    writeFileSync(results, JSON.stringify(store, null, 2));
    log(
      `${id} arm ${armId}: ${outcome.resolved ? 'RESOLVED' : 'not resolved'}` +
        (gold
          ? ''
          : `, ${agent.turns} turns, $${agent.costUsdEquivalent} eq, ${agent.yandecodeToolCalls} yandecode calls, ${Math.round(agent.wallMs / 1000)}s`),
    );
  }
  reset();
}
log(`done — ${results}`);
