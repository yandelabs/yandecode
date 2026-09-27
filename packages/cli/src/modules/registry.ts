import { codeModule } from './code/definition';
import { contextModule } from './context/definition';
import { guardModule } from './guard/definition';
import { instructionsModule } from './instructions/definition';
import { knowledgeModule } from './knowledge/definition';
import { libdocsModule } from './libdocs/definition';
import { lspModule } from './lsp/definition';
import { qualityModule } from './quality/definition';
import { routerModule } from './router/definition';
import { workflowModule } from './workflow/definition';
import type { ModuleDefinition } from './contract';

/**
 * Every module YandeCode ships, in presentation order. Definitions are light (metadata, tool
 * schemas, hook bindings); each module's heavy code loads only through `load()`.
 * Adding a module: create modules/<id>/definition.ts + runtime.ts and list it here.
 */
export const MODULES: readonly ModuleDefinition[] = [
  codeModule,
  lspModule,
  contextModule,
  knowledgeModule,
  libdocsModule,
  qualityModule,
  workflowModule,
  instructionsModule,
  guardModule,
  routerModule,
];
