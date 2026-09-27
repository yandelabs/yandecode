<a id="readme-top"></a>

<!-- PROJECT SHIELDS -->

[![Contributors][contributors-shield]][contributors-url]
[![Forks][forks-shield]][forks-url]
[![Stargazers][stars-shield]][stars-url]
[![Issues][issues-shield]][issues-url]
[![MIT License][license-shield]][license-url]

<!-- PROJECT LOGO -->
<br />
<div align="center">
  <h3 align="center">YandeCode</h3>

  <p align="center">
    A modular context harness for Claude Code — code navigation, output isolation, persistent memory, dependency docs, workflows, quality checks and a tool-call guard, installed once and chosen per project.
    <br />
    <a href="docs/architecture.md"><strong>Read the architecture »</strong></a>
    <br />
    <br />
    <a href="examples/demo">See the demo</a>
    &middot;
    <a href="https://github.com/yandelabs/yandecode/issues/new?labels=bug">Report Bug</a>
    &middot;
    <a href="https://github.com/yandelabs/yandecode/issues/new?labels=enhancement">Request Feature</a>
  </p>
</div>

<!-- TABLE OF CONTENTS -->
<details>
  <summary>Table of Contents</summary>
  <ol>
    <li><a href="#about-the-project">About The Project</a></li>
    <li><a href="#getting-started">Getting Started</a></li>
    <li><a href="#usage">Usage</a></li>
    <li><a href="#modules">Modules</a></li>
    <li><a href="#what-gets-added-to-your-project">What Gets Added To Your Project</a></li>
    <li><a href="#benchmarks">Benchmarks</a></li>
    <li><a href="#roadmap">Roadmap</a></li>
    <li><a href="#contributing">Contributing</a></li>
    <li><a href="#license">License</a></li>
    <li><a href="#acknowledgments">Acknowledgments</a></li>
  </ol>
</details>

<!-- ABOUT THE PROJECT -->

## About The Project

YandeCode is **not** a replacement for Claude Code. It is a harness around it — `Agent = Claude Code + YandeCode` — that spends the context window on what matters: it answers "where is X" with a few `path:line` rows instead of whole files, keeps 200 000-token test logs out of the conversation while leaving every line retrievable, remembers decisions across sessions, and reads the docs of the dependency version you actually have installed.

Everything is a module you choose at `yandecode init`: a disabled module adds no tools, hooks, skills, processes or tokens. Everything runs locally — no API keys, no hosted services, no model downloads — and Claude Code stays responsible for models, authentication and permissions ([ADR-001](docs/adr/ADR-001-claude-code-as-execution-runtime.md)).

Built with TypeScript on Node.js 22+, [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) (FTS5), [web-tree-sitter](https://github.com/tree-sitter/tree-sitter), the [Model Context Protocol SDK](https://modelcontextprotocol.io/) and [zod](https://zod.dev).

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- GETTING STARTED -->

## Getting Started

### Prerequisites

- Node.js 22 or newer and npm
- [Claude Code](https://code.claude.com/docs/en/setup)
- Git (optional, used to honour `.gitignore`)

### Installation

```bash
npm install -g yandecode
cd your-project
yandecode init          # pick modules interactively
yandecode doctor        # verify
```

Restart Claude Code in the project afterwards. One package brings every module; nothing else (Serena, claude-mem, context-mode, …) needs to be installed. The only on-demand download is a language server, the first time the optional `lsp` module needs one.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- USAGE -->

## Usage

```bash
yandecode init                          # interactive module picker (TTY)
yandecode init --yes                    # defaults, non-interactive (CI, agents)
yandecode init --modules code,knowledge # exactly these (+ their dependencies)
yandecode init --all | --minimal

yandecode modules                       # list modules and which are enabled
yandecode modules info lsp              # tools, hooks, skills, requirements of one module
yandecode modules enable guard lsp
yandecode modules disable guard         # removes its hooks/skills/tools; --purge deletes its data

yandecode status                        # enabled modules and integration state
yandecode doctor                        # environment, integration and per-module checks
yandecode update                        # after upgrading: re-apply integration, migrate config
yandecode uninstall [--purge]           # remove everything YandeCode added

yandecode code search <query>           # module commands, also usable from the terminal
yandecode instructions audit
yandecode lsp install typescript
yandecode context purge
```

Inside Claude Code nothing changes: the enabled modules' tools appear under the `yandecode` MCP server (Claude Code loads them on demand), their skills in `.claude/skills/`, and a short managed block in `CLAUDE.md` tells the agent when to use them.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Modules

| module         | default | what it gives the agent                                                                                                                                                                                                                  |
| -------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `code`         | on      | `code_search` (symbols, `Class/method` paths, file fragments, plain words), `code_symbols`, `code_definition`, `code_references`, `repo_map` — tree-sitter symbols + BM25 + import-graph PageRank; always fresh, no index command needed |
| `lsp`          | off     | `lsp_references`, `lsp_definition`, `lsp_diagnostics` through typescript-language-server / pyright (installed into the user cache on first use)                                                                                          |
| `context`      | on      | `ctx_run` / `ctx_fetch` run commands and fetch pages outside the context window and return a digest; `ctx_search` / `ctx_get` read any part verbatim; blocks `curl` to stdout and hints once for verbose commands                        |
| `knowledge`    | on      | `knowledge_search` / `knowledge_get` over project Markdown and memories; `memory_write` / `memory_forget`; decisions injected at session start, related memories pointed out per prompt, sessions summarized automatically               |
| `libdocs`      | on      | `libdocs_resolve` / `libdocs_query`: README, docs and type declarations of the dependency version installed in `node_modules` or the project venv                                                                                        |
| `quality`      | on      | `quality_check` runs the project's own typecheck/lint/tests and returns only failures; security warnings right after risky edits; code and security review skills with confidence-filtered reviewer agents                               |
| `workflow`     | on      | `work_new/status/next/check/archive` over resumable change folders (OpenSpec-shaped) + skills for the workflow, TDD, debugging and verification                                                                                          |
| `instructions` | on      | `instructions_audit`: size, broken paths, unknown commands and duplicates in `CLAUDE.md` / `AGENTS.md`, plus detected conventions                                                                                                        |
| `guard`        | off     | `PreToolUse` guard: secrets in commands/content/commits, credential files, `sudo`, destructive commands; fail-open, overridable with `# guard-ok: <reason>`                                                                              |

Details, settings and design decisions: [docs/modules.md](docs/modules.md).

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## What Gets Added To Your Project

| path                                                       | what                                                                                                       | removed by                     |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `yandecode.json`                                           | `{ "version": 2, "modules": [...] }` plus optional per-module settings                                     | `uninstall`                    |
| `.claude/settings.json`                                    | one hook entry per event the enabled modules need (`yandecode hook <Event>`); your other settings are kept | `modules disable`, `uninstall` |
| `.mcp.json`                                                | the `yandecode` MCP server, only when an enabled module has tools                                          | same                           |
| `.claude/skills/yandecode-*`, `.claude/agents/yandecode-*` | skills and agents of enabled modules; files you edit are never overwritten or deleted                      | same                           |
| `CLAUDE.md`                                                | a `<!-- yandecode:start -->` block with one line per enabled module                                        | same                           |
| `.yandecode/` (git-ignored)                                | per-module SQLite files, memories, logs, managed-file manifest                                             | `uninstall --purge`            |

Upgrading from 0.1: `npm install -g yandecode@latest && yandecode update` — see [docs/migration-v2.md](docs/migration-v2.md).

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Benchmarks

`npm run build && npm run bench` runs [`benchmarks/run.ts`](benchmarks/run.ts); `node scripts/verify-install.mjs` checks a clean install; `node scripts/e2e-claude.mjs` drives two real Claude Code sessions. Results are committed in [`benchmarks/results/`](benchmarks/results) — summary in [SUMMARY.md](benchmarks/results/SUMMARY.md).

|                                           | v0.1 (hybrid vector RAG) | v0.2                                                      |
| ----------------------------------------- | ------------------------ | --------------------------------------------------------- |
| Recall@1 / @5 on the 12-query fixture set | 0.42 / 0.67              | 0.83 / 1.00                                               |
| MRR                                       | 0.51                     | 0.90                                                      |
| tokens returned for the 12 queries        | 4 718                    | 4 092                                                     |
| hook latency                              | ~350 ms                  | 73–90 ms (all default modules)                            |
| resident memory                           | 383 MB                   | 165 MB                                                    |
| 50 000-line test log through `ctx_run`    | —                        | 197 k → 440 tokens, failure shown, every line recoverable |

Token numbers are a proxy, not a guarantee: on `fixtures/repo-auth/` files are small (reading the expected files for all 12 queries costs ~6 000 tokens), so savings mainly show on larger repositories — compare per query in the result JSON before citing an aggregate (this caveat and the per-query comparison come from the 0.1 `benchmark:rag:tokens` script).

<p align="right">(<a href="#readme-top">back to top</a>)</p>

## Roadmap

- [x] 0.1 — hybrid vector RAG, swarm orchestration, SQLite memory
- [x] 0.2 — modular core, structural code navigation, LSP, context isolation, file-based memory, dependency docs, workflows, quality, instructions audit, guard ([ADRs 016–025](docs/adr))
- [ ] Optional semantic search for knowledge, if lexical recall proves insufficient on real projects ([ADR-025](docs/adr/ADR-025-lazy-loading-over-daemon.md))
- [ ] More language servers (Go, Rust, Java)

See the [open issues](https://github.com/yandelabs/yandecode/issues) for proposed features and known issues.

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONTRIBUTING -->

## Contributing

Contributions are welcome: open an issue tagged "enhancement" or a pull request. Read [docs/development.md](docs/development.md) first — it covers the layout, how to add a module, TDD and the checks every commit must pass.

```bash
npm install
npm run check   # typecheck + eslint (strict) + prettier + tests
npm run build   # bundles packages/cli/dist
```

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- LICENSE -->

## License

Distributed under the MIT License. See [`LICENSE`](LICENSE). Bundled workflow skills adapt [obra/superpowers](https://github.com/obra/superpowers) (MIT) — see [`packages/content/skills/NOTICE.md`](packages/content/skills/NOTICE.md).

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- CONTACT -->

## Contact

Project Link: [https://github.com/yandelabs/yandecode](https://github.com/yandelabs/yandecode)

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- ACKNOWLEDGMENTS -->

## Acknowledgments

Studied while designing 0.2 (behaviour and interfaces; code reused only where the license allows, see [the study](docs/research/2026-09-26-reference-study.md)):

- [Serena](https://github.com/oraios/serena) — symbol-level navigation with name paths and answer budgets
- [context-mode](https://github.com/mksglu/context-mode) — running noisy tools outside the context window
- [claude-mem](https://github.com/thedotmack/claude-mem) — progressive disclosure of memory and hook-output budgets
- [Superpowers](https://github.com/obra/superpowers) — workflow, TDD, debugging and verification skills
- [OpenSpec](https://github.com/Fission-AI/OpenSpec) — change folders and spec-driven development
- [claude-plugins-official](https://github.com/anthropics/claude-plugins-official) — code review, security guidance, CLAUDE.md management, LSP plugins
- [jev-kit](https://github.com/jonathanavis96/jev-kit) — the AIRLOCK tool-call guard
- [Claude Code](https://code.claude.com/docs) — the runtime YandeCode is built around
- [Best-README-Template](https://github.com/othneildrew/Best-README-Template) — this file's structure

<p align="right">(<a href="#readme-top">back to top</a>)</p>

<!-- MARKDOWN LINKS & IMAGES -->

[contributors-shield]: https://img.shields.io/github/contributors/yandelabs/yandecode.svg?style=for-the-badge
[contributors-url]: https://github.com/yandelabs/yandecode/graphs/contributors
[forks-shield]: https://img.shields.io/github/forks/yandelabs/yandecode.svg?style=for-the-badge
[forks-url]: https://github.com/yandelabs/yandecode/network/members
[stars-shield]: https://img.shields.io/github/stars/yandelabs/yandecode.svg?style=for-the-badge
[stars-url]: https://github.com/yandelabs/yandecode/stargazers
[issues-shield]: https://img.shields.io/github/issues/yandelabs/yandecode.svg?style=for-the-badge
[issues-url]: https://github.com/yandelabs/yandecode/issues
[license-shield]: https://img.shields.io/github/license/yandelabs/yandecode.svg?style=for-the-badge
[license-url]: https://github.com/yandelabs/yandecode/blob/main/LICENSE
