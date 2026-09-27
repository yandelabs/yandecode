// A/B benchmark on short SWE-bench Verified instances: Claude Code fixes a real issue with
// YandeCode (arm A) and without (arm B), same commit, prompt and model. Success is the
// benchmark's own criterion: the hidden test patch is applied over the agent's work, the
// FAIL_TO_PASS tests must pass and the touched test files must stay green.
//
// Each instance is shallow-cloned at its base commit into <work>/<repo>-<number> with a local
// .venv (built from --python) and tagged `ab-base`. Runs are sequential and resumable.
//
// Usage:
//   node benchmarks/ab/swe.mjs --python /path/to/python3.11 [--model claude-opus-5-5] \
//     [--budget 3] [--instances django__django-17087] [--arms A,B] [--work ~/.cache/yandecode-swe]
import { execFileSync, spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
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
const here = dirname(fileURLToPath(import.meta.url));
const all = JSON.parse(readFileSync(join(here, 'swe', 'instances.json'), 'utf8'));
const wanted = arg('instances', all.map((i) => i.instance_id).join(',')).split(',');
const instances = all.filter((i) => wanted.includes(i.instance_id));
const model = arg('model', 'claude-opus-5-5');
const budget = arg('budget', '3');
const arms = arg('arms', 'B,A').split(',');
const python = arg('python', 'python3');
const work = resolve(arg('work', join(homedir(), '.cache', 'yandecode-swe')));
const results = join(work, process.argv.includes('--gold') ? 'results-gold.json' : 'results.json');
const tmp = join(work, 'tmp');
mkdirSync(tmp, { recursive: true });
const env = { ...process.env, TMPDIR: tmp };
const AGENT_TIMEOUT_MS = 20 * 60_000;
/** Files the harness or YandeCode writes; never part of the agent's fix. */
/** --gold: apply the reference fix instead of running the agent (validates the harness). */
const gold = process.argv.includes('--gold');
const HARNESS_PATHS = ['.venv', '.tool-versions', '.yandecode', '.claude', '.mcp.json'];

const log = (text) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${text}`);
const dirOf = (inst) =>
  join(work, `${inst.repo.split('/')[1]}-${inst.instance_id.split('-').pop()}`);

function shell(cwd) {
  const sh = (cmd, args, opts = {}) =>
    spawnSync(cmd, args, { cwd, env, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
  const git = (...args) => {
    const r = sh('git', args);
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  return { sh, git };
}

/** Shallow clone at the base commit plus an editable install in a local virtualenv. */
function prepareClone(inst) {
  const dir = dirOf(inst);
  if (existsSync(join(dir, '.venv'))) return;
  mkdirSync(dir, { recursive: true });
  const { sh, git } = shell(dir);
  git('init', '-q');
  git('fetch', '-q', '--depth', '1', `https://github.com/${inst.repo}.git`, inst.base_commit);
  git('checkout', '-q', 'FETCH_HEAD');
  git('tag', 'ab-base');
  appendFileSync(join(dir, '.git', 'info', 'exclude'), `${HARNESS_PATHS.join('\n')}\n`);
  // asdf shims refuse to run a tool the directory does not pin: both Python and the Node that
  // runs yandecode (its hooks and MCP server) need an entry.
  writeFileSync(join(dir, '.tool-versions'), `python 3.11.15\nnodejs ${process.versions.node}\n`);
  execFileSync(python, ['-m', 'venv', '.venv'], { cwd: dir });
  // Shallow clones have no tags, so setuptools-scm needs the version spelled out.
  const pip = sh('.venv/bin/pip', ['install', '-q', '-e', '.'], {
    env: { ...env, SETUPTOOLS_SCM_PRETEND_VERSION: `${inst.version}.0` },
  });
  if (pip.status !== 0) throw new Error(`pip install failed in ${dir}: ${pip.stderr}`);
}

function reset(inst) {
  const { git } = shell(dirOf(inst));
  git('reset', '-q', '--hard', 'ab-base');
  // No -x: ignored build metadata (egg-info, generated _version.py) belongs to the install.
  git('clean', '-q', '-fd');
  for (const path of ['.yandecode', '.claude', '.mcp.json', 'yandecode.json'])
    rmSync(join(dirOf(inst), path), { recursive: true, force: true });
}

const testFiles = (inst) => [...inst.test_patch.matchAll(/^\+\+\+ b\/(\S+)/gm)].map((m) => m[1]);

function testCommand(inst, targets, kind) {
  if (inst.repo === 'django/django') {
    const labels =
      kind === 'ids'
        ? targets.map((id) => /\(([^)]+)\)/.exec(id)?.[1] ?? id)
        : targets.map((f) =>
            f
              .replace(/^tests\//, '')
              .replace(/\.py$/, '')
              .replaceAll('/', '.'),
          );
    return ['tests/runtests.py', '--parallel', '1', ...labels];
  }
  return ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', ...targets];
}

function runTests(inst, targets, kind) {
  const r = shell(dirOf(inst)).sh('.venv/bin/python', testCommand(inst, targets, kind), {
    timeout: 10 * 60_000,
  });
  const tail = `${r.stdout}${r.stderr}`.trim().split('\n').slice(-2).join(' | ');
  return { passed: r.status === 0, tail };
}

function howToTest(inst) {
  return inst.repo === 'django/django'
    ? 'Run tests with `.venv/bin/python tests/runtests.py <module>` (e.g. `migrations.test_writer`).'
    : 'Run tests with `.venv/bin/python -m pytest <path>`.';
}

function prompt(inst) {
  return [
    `You are working in a checkout of ${inst.repo} (this directory). Resolve the following issue:`,
    '',
    '<issue>',
    inst.problem_statement.trim(),
    '</issue>',
    '',
    `The project's Python environment is \`.venv\`. ${howToTest(inst)}`,
    'Make the minimal source change that fixes the issue and add or adjust a test for it.',
    'Work autonomously and do not ask questions.',
  ].join('\n');
}

function setupArm(inst, armId) {
  const dir = dirOf(inst);
  const mcp = join(work, `mcp-${armId}.json`);
  if (!armId.startsWith('A')) {
    writeFileSync(mcp, JSON.stringify({ mcpServers: {} }));
    return mcp;
  }
  execFileSync('yandecode', ['init', '--all'], { cwd: dir, env, stdio: 'ignore' });
  return join(dir, '.mcp.json');
}

function applyGold(inst) {
  writeFileSync(join(dirOf(inst), '.gold.patch'), inst.patch);
  shell(dirOf(inst)).git('apply', '.gold.patch');
  rmSync(join(dirOf(inst), '.gold.patch'));
  return { gold: true, rateLimited: false, yandecodeToolCalls: 0, wallMs: 0 };
}

/** Saves the agent's patch, then judges it with the hidden tests like SWE-bench does. */
function evaluate(inst, armId) {
  const { sh, git } = shell(dirOf(inst));
  git('add', '-A');
  const excluded = [...HARNESS_PATHS, 'yandecode.json', 'CLAUDE.md', 'AGENTS.md', '.gitignore'].map(
    (p) => `:!${p}`,
  );
  const patch = sh('git', ['diff', '--cached', 'ab-base', '--', '.', ...excluded]).stdout;
  writeFileSync(join(work, `patch-${inst.instance_id}-${armId}.diff`), patch);
  const files = testFiles(inst);
  // The hidden tests replace whatever the agent did to those files.
  for (const file of files) {
    if (git('ls-tree', 'ab-base', file)) git('checkout', 'ab-base', '--', file);
    else rmSync(join(dirOf(inst), file), { force: true });
  }
  writeFileSync(join(dirOf(inst), '.test.patch'), inst.test_patch);
  git('apply', '.test.patch');
  rmSync(join(dirOf(inst), '.test.patch'));
  const failToPass = runTests(inst, JSON.parse(inst.FAIL_TO_PASS), 'ids');
  const touchedFiles = runTests(inst, files, 'files');
  return {
    patchLines: patch.split('\n').filter((l) => /^[+-][^+-]/.test(l)).length,
    resolved: failToPass.passed && touchedFiles.passed,
    failToPass,
    touchedFiles,
  };
}

const store = existsSync(results) ? JSON.parse(readFileSync(results, 'utf8')) : { runs: [] };
for (const inst of instances) {
  prepareClone(inst);
  for (const armId of arms) {
    const id = inst.instance_id;
    if (store.runs.some((r) => r.instance === id && r.arm === armId && !r.agent.rateLimited))
      continue;
    log(`${id} arm ${armId}: start`);
    reset(inst);
    const mcpConfig = setupArm(inst, armId);
    const agent = gold
      ? applyGold(inst)
      : await runAgent({
          cwd: dirOf(inst),
          env,
          prompt: prompt(inst),
          model,
          budget,
          mcpConfig,
          transcript: join(work, `transcript-${id}-${armId}.jsonl`),
          timeoutMs: AGENT_TIMEOUT_MS,
        });
    store.runs = store.runs.filter((r) => !(r.instance === id && r.arm === armId));
    if (agent.rateLimited) {
      store.runs.push({ instance: id, arm: armId, model, agent });
      writeFileSync(results, JSON.stringify(store, null, 2));
      log(`${id} arm ${armId}: usage limit reached — stopping; rerun later to resume`);
      process.exit(2);
    }
    const outcome = evaluate(inst, armId);
    store.runs.push({ instance: id, arm: armId, model, agent, outcome });
    writeFileSync(results, JSON.stringify(store, null, 2));
    log(
      `${id} arm ${armId}: ${outcome.resolved ? 'RESOLVED' : 'not resolved'}, ${agent.turns} turns, ` +
        `$${agent.costUsdEquivalent} eq, ${agent.yandecodeToolCalls} yandecode calls, ${Math.round(agent.wallMs / 1000)}s`,
    );
  }
  reset(inst);
}
log(`done — ${results}`);
