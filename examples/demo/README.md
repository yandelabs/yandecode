# Demo: investigate a failure and fix it

`demo.mjs` drives YandeCode through the same MCP stdio interface Claude Code uses, on the small `project/` here (a cart library whose total ignores quantities). It needs no model or credentials.

```bash
npm install && npm run build
node examples/demo/demo.mjs
```

What it shows, module by module:

| step                                                         | module            | tool                             |
| ------------------------------------------------------------ | ----------------- | -------------------------------- |
| open a resumable change with a task and acceptance criterion | workflow          | `work_new`, `work_next`          |
| run the project's tests and see only the failure             | quality           | `quality_check`                  |
| find the code without reading whole files                    | code              | `code_search`, `code_definition` |
| verify the fix, record evidence on the task                  | quality, workflow | `quality_check`, `work_check`    |
| remember the root cause for later sessions                   | knowledge         | `memory_write`                   |
| run a noisy command outside the context window               | context           | `ctx_run`                        |
| find the lesson by asking in different words                 | knowledge         | `knowledge_search`               |

For the same flow with a real model, see `scripts/e2e-claude.mjs`.
