// A/B benchmark: the same OpenSpec tasks done by Claude Code with YandeCode (arm A) and without
// (arm B), from the same commit, prompt and model. Success is judged by hidden acceptance
// programs plus the repository's own test suite; cost, tokens, turns and time come from the
// stream-json result. Runs are sequential (shared cargo target) and resumable.
//
// Usage:
//   node benchmarks/ab/run.mjs --workspace ~/workspace/projects/pacolang --suite benchmarks/ab/pacolang \
//     [--model claude-sonnet-5] [--budget 5] [--tasks F1,M1] [--arms A,B] [--work /tmp/ab]
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { runAgent } from './agent.mjs';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const suiteDir = resolve(arg('suite', 'benchmarks/ab/pacolang'));
const suite = JSON.parse(readFileSync(join(suiteDir, 'tasks.json'), 'utf8'));
const workspace = resolve(arg('workspace', ''));
const model = arg('model', 'claude-sonnet-5');
const budget = arg('budget', '5');
const work = resolve(arg('work', '/tmp/yandecode-ab'));
const taskIds = arg('tasks', suite.tasks.map((t) => t.id).join(',')).split(',');
const arms = arg('arms', 'A,B').split(',');
const repo = join(work, suite.repo);
const target = join(work, 'target');
const results = join(work, process.argv.includes('--dry') ? 'results-dry.json' : 'results.json');
// Temp files on the work dir's disk: a small tmpfs /tmp fills up during the leak-check suite
// and turns disk exhaustion into fake regressions.
const tmp = join(work, 'tmp');
mkdirSync(tmp, { recursive: true });
const env = { ...process.env, CARGO_TARGET_DIR: target, TMPDIR: tmp };
const AGENT_TIMEOUT_MS = 45 * 60_000;
/** --dry: skip the agent and evaluate the untouched base (validates the harness itself). */
const dry = process.argv.includes('--dry');

const sh = (cmd, args, opts = {}) =>
  spawnSync(cmd, args, { cwd: repo, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
const git = (...args) => {
  const r = sh('git', args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const log = (text) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${text}`);

function commitChanges(message) {
  git('add', '-A');
  git('-c', 'user.email=ab@example.com', '-c', 'user.name=ab', 'commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD');
}

/**
 * The base commit: suite.baseCommit plus copies of the OpenSpec changes under test (they live
 * outside the repo). Tasks added later get their change committed on top, keeping earlier runs'
 * base valid.
 */
function prepareBase() {
  mkdirSync(work, { recursive: true });
  const baseFile = join(work, 'BASE');
  if (!existsSync(repo))
    execFileSync('git', ['clone', '-q', '--shared', join(workspace, suite.repo), repo]);
  if (!existsSync(baseFile)) git('checkout', '-q', '-B', 'ab-base', suite.baseCommit);
  else reset(readFileSync(baseFile, 'utf8').trim());
  const missing = suite.tasks.filter(
    (t) => !existsSync(join(repo, 'openspec', 'changes', t.change)),
  );
  if (missing.length === 0 && existsSync(baseFile)) return readFileSync(baseFile, 'utf8').trim();
  for (const task of missing) {
    cpSync(
      join(workspace, suite.repo, suite.openspecChanges, task.change),
      join(repo, 'openspec', 'changes', task.change),
      {
        recursive: true,
      },
    );
  }
  const base = commitChanges(
    `ab: openspec changes under test (${missing.map((t) => t.id).join(', ') || 'none'})`,
  );
  writeFileSync(baseFile, base);
  return base;
}

function reset(base) {
  git('reset', '-q', '--hard', base);
  // Keep in-repo build outputs (e.g. runtime/target holds the runtime library tests link against).
  git('clean', '-q', '-fdx', '-e', 'runtime/target', '-e', 'compiler/target');
}

/** Suite-specific setup after each reset (e.g. seeding build artifacts). */
function prepare() {
  if (!suite.prepare) return;
  const r = sh('sh', ['-c', suite.prepare], { env: { ...env, WORKSPACE: workspace } });
  if (r.status !== 0) throw new Error(`prepare failed: ${r.stderr}`);
}

function setupArm(armId) {
  const mcp = join(work, `mcp-${armId}.json`);
  if (!armId.startsWith('A')) {
    writeFileSync(mcp, JSON.stringify({ mcpServers: {} }));
    return mcp;
  }
  execFileSync('yandecode', ['init', suite.setupA.modules], { cwd: repo, env, stdio: 'ignore' });
  const config = JSON.parse(readFileSync(join(repo, 'yandecode.json'), 'utf8'));
  writeFileSync(
    join(repo, 'yandecode.json'),
    `${JSON.stringify({ ...config, ...suite.setupA.settings }, null, 2)}\n`,
  );
  return join(repo, '.mcp.json');
}

function prompt(task) {
  return [
    `You are working in the Paco compiler repository (this directory).`,
    `Implement ${task.scope} of the OpenSpec change \`openspec/changes/${task.change}\`: read its proposal.md, design.md (if any), specs/ and tasks.md first.`,
    `Follow the conventions in AGENTS.md. Verify the implemented tasks with tests as tasks.md describes,`,
    `make sure \`cargo test --manifest-path compiler/Cargo.toml --workspace\` passes, and mark the implemented tasks as [x] in tasks.md.`,
    `Do not work on other tasks. Work autonomously and do not ask questions.`,
  ].join('\n');
}

function runTask(task, armId, mcpConfig) {
  return runAgent({
    cwd: repo,
    env,
    prompt: prompt(task),
    model,
    budget,
    mcpConfig,
    transcript: join(work, `transcript-${task.id}-${armId}.jsonl`),
    timeoutMs: AGENT_TIMEOUT_MS,
  });
}

function evaluate(task, base, armLabel) {
  const excluded = [':!CLAUDE.md', ':!yandecode.json', ':!.mcp.json'];
  git('add', '-A');
  const diff = sh('git', [
    'diff',
    '--cached',
    '--shortstat',
    base,
    '--',
    '.',
    ...excluded,
  ]).stdout.trim();
  // Keep the full patch for post-mortems (the repo is reset before the next run).
  const patch = sh('git', ['diff', '--cached', base, '--', '.', ...excluded]).stdout;
  writeFileSync(join(work, `patch-${task.id}-${armLabel}.diff`), patch);
  const tasksMd = readFileSync(join(repo, 'openspec', 'changes', task.change, 'tasks.md'), 'utf8');
  const build = sh('cargo', [
    'build',
    '-q',
    '--manifest-path',
    'compiler/Cargo.toml',
    '-p',
    'paco-driver',
  ]);
  const paco = join(target, 'debug', 'paco');
  const accept = task.accept.map((a) => {
    if (build.status !== 0) return { ...a, pass: false, detail: 'build failed' };
    const file = a.file ? join(suiteDir, 'accept', a.file) : null;
    const r =
      a.kind === 'cmd'
        ? sh('sh', ['-c', a.cmd])
        : sh(paco, [a.kind === 'run' ? 'run' : 'check', file], { timeout: 300_000 });
    // The file name must not satisfy the pattern (e.g. "bad_binary_digit" vs /binary/).
    const output = `${r.stdout}${r.stderr}`.replaceAll(file ?? '\0', '<file>');
    const pass =
      a.kind === 'run'
        ? r.status === 0 && r.stdout.trim() === a.stdout
        : a.kind === 'check-fails'
          ? r.status !== 0 && new RegExp(a.match, 'i').test(output)
          : r.status === 0;
    return {
      kind: a.kind,
      file: a.file ?? a.cmd,
      pass,
      detail: output.trim().split('\n').slice(0, 3).join(' | '),
    };
  });
  const regression = sh('sh', ['-c', suite.regression], { timeout: 30 * 60_000 });
  const regressionOutput = `${regression.stdout}${regression.stderr}`;
  const failedTests = [...regressionOutput.matchAll(/^(\S+) --- FAILED$/gm)].map((m) => m[1]);
  // A test that fails in the full parallel run but passes alone is flaky, not a regression.
  const flakyTests = failedTests.filter(
    (name) =>
      sh('sh', ['-c', `${suite.regression} -- --exact ${name}`], { timeout: 10 * 60_000 })
        .status === 0,
  );
  const regressionPassed =
    regression.status === 0 || (failedTests.length > 0 && flakyTests.length === failedTests.length);
  return {
    diff,
    tasksChecked: (tasksMd.match(/- \[x\]/g) ?? []).length,
    accept,
    acceptancePassed: accept.filter((a) => a.pass).length,
    acceptanceTotal: accept.length,
    regressionPassed,
    flakyTests,
    regressionTail: `${regression.stdout}${regression.stderr}`
      .trim()
      .split('\n')
      .slice(-3)
      .join(' | '),
    failedTests,
  };
}

/** --reeval: re-run acceptance and regression on each saved patch (no model calls). */
function reevaluate(store, base) {
  for (const run of store.runs.filter((r) => r.outcome)) {
    const patch = join(work, `patch-${run.task}-${run.arm}.diff`);
    if (!existsSync(patch)) {
      log(`${run.task} arm ${run.arm}: no saved patch, cannot re-evaluate`);
      continue;
    }
    reset(base);
    prepare();
    if (readFileSync(patch, 'utf8').trim()) git('apply', '--index', patch);
    const task = suite.tasks.find((t) => t.id === run.task);
    run.outcomeFirstEvaluation ??= run.outcome;
    run.outcome = evaluate(task, base, `${run.arm}-reeval`);
    writeFileSync(results, JSON.stringify(store, null, 2));
    log(
      `${run.task} arm ${run.arm}: re-evaluated acceptance ${run.outcome.acceptancePassed}/${run.outcome.acceptanceTotal}, regression ${run.outcome.regressionPassed ? 'ok' : `FAIL ${run.outcome.failedTests.join(',')}`}`,
    );
  }
  reset(base);
}

const base = prepareBase();
const store = existsSync(results)
  ? JSON.parse(readFileSync(results, 'utf8'))
  : { model, base, runs: [] };
if (process.argv.includes('--reeval')) {
  reevaluate(store, base);
  process.exit(0);
}
for (const id of taskIds) {
  const task = suite.tasks.find((t) => t.id === id);
  for (const armId of arms) {
    if (store.runs.some((r) => r.task === id && r.arm === armId && !r.agent.rateLimited)) continue;
    log(`${id} (${task.level}) arm ${armId}: start`);
    reset(base);
    prepare();
    const mcp = setupArm(armId);
    const agent = dry ? { dry: true, rateLimited: false } : await runTask(task, armId, mcp);
    if (agent.rateLimited) {
      log(`${id} arm ${armId}: usage limit reached — stopping; rerun later to resume`);
      store.runs.push({ task: id, level: task.level, arm: armId, agent });
      writeFileSync(results, JSON.stringify(store, null, 2));
      process.exit(2);
    }
    const outcome = evaluate(task, base, armId);
    store.runs = store.runs.filter((r) => !(r.task === id && r.arm === armId));
    store.runs.push({ task: id, level: task.level, arm: armId, agent, outcome });
    writeFileSync(results, JSON.stringify(store, null, 2));
    log(
      `${id} arm ${armId}: acceptance ${outcome.acceptancePassed}/${outcome.acceptanceTotal}, regression ${outcome.regressionPassed ? 'ok' : 'FAIL'}, ` +
        `${agent.turns} turns, $${agent.costUsdEquivalent} eq, ${Math.round(agent.wallMs / 60000)} min`,
    );
  }
}
reset(base);
log(`done — ${results}`);
