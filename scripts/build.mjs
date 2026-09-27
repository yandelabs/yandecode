// Bundles the CLI into packages/cli/dist (the only published package).
// Code splitting keeps each module's runtime in its own chunk, so dynamic import() stays lazy.
import { chmodSync, cpSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cli = join(root, 'packages', 'cli');
const outdir = join(cli, 'dist');
const pkg = JSON.parse(readFileSync(join(cli, 'package.json'), 'utf8'));

rmSync(outdir, { recursive: true, force: true });
await build({
  entryPoints: { bin: join(cli, 'src', 'bin.ts') },
  outdir,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  tsconfig: join(root, 'tsconfig.json'),
  // Native addons and WASM grammars must be resolved from node_modules at runtime.
  external: Object.keys(pkg.dependencies).filter((name) =>
    ['better-sqlite3', 'web-tree-sitter', 'tree-sitter-wasms'].includes(name),
  ),
  banner: {
    js: "import { createRequire as __yandecodeCreateRequire } from 'node:module';\nconst require = __yandecodeCreateRequire(import.meta.url);",
  },
  chunkNames: 'chunks/[name]-[hash]',
  sourcemap: 'linked',
  logLevel: 'warning',
});
cpSync(join(root, 'packages', 'content'), join(outdir, 'content'), { recursive: true });
chmodSync(join(outdir, 'bin.js'), 0o755);
console.log(`built ${pkg.name}@${pkg.version} → ${outdir}`);
