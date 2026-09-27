import { Command } from 'commander';
import { YandeCodeError } from '@yandecode/core';
import { processIo } from '@cli/io';
import { MODULES } from '@cli/modules/registry';
import { VERSION } from '@cli/version';

const io = processIo();
const cwd = (): string => process.cwd();

/** Core commands; each loads its implementation only when invoked. */
function buildProgram(): Command {
  const program = new Command()
    .name('yandecode')
    .description('YandeCode — modular context harness for Claude Code')
    .version(VERSION, '-v, --version')
    .showHelpAfterError();

  program
    .command('init')
    .description('Set up YandeCode in this project and choose modules')
    .option('-m, --modules <list>', 'comma-separated module ids (non-interactive)')
    .option('--all', 'enable every module')
    .option('--minimal', 'enable no optional module')
    .option('-y, --yes', 'accept the current/default selection without prompting')
    .option('--force', 'overwrite managed files even if you edited them')
    .action(
      async (flags: {
        modules?: string;
        all?: boolean;
        minimal?: boolean;
        yes?: boolean;
        force?: boolean;
      }) => {
        const { runInit } = await import('@cli/commands/init');
        process.exitCode = await runInit(cwd(), flags, io);
      },
    );

  const modules = program
    .command('modules')
    .description('List, inspect, enable or disable modules');
  modules
    .command('list', { isDefault: true })
    .description('Show all modules and which are enabled')
    .action(async () => {
      const { runModulesList } = await import('@cli/commands/modules');
      process.exitCode = runModulesList(cwd(), io);
    });
  modules
    .command('info <id>')
    .description('Show what a module adds (tools, hooks, skills, requirements)')
    .action(async (id: string) => {
      const { runModulesInfo } = await import('@cli/commands/modules');
      process.exitCode = runModulesInfo(id, io);
    });
  modules
    .command('enable <ids...>')
    .description('Enable modules (dependencies are enabled too)')
    .action(async (ids: string[]) => {
      const { runModulesEnable } = await import('@cli/commands/modules');
      process.exitCode = runModulesEnable(cwd(), ids, io);
    });
  modules
    .command('disable <ids...>')
    .description('Disable modules and remove their tools, hooks, skills and agents')
    .option('--cascade', 'also disable modules that depend on them')
    .option('--purge', "delete the modules' local data in .yandecode/")
    .action(async (ids: string[], flags: { cascade?: boolean; purge?: boolean }) => {
      const { runModulesDisable } = await import('@cli/commands/modules');
      process.exitCode = runModulesDisable(cwd(), ids, flags, io);
    });

  program
    .command('status')
    .description('Show enabled modules and integration state')
    .action(async () => {
      const { runStatus } = await import('@cli/commands/status');
      process.exitCode = runStatus(cwd(), io);
    });
  program
    .command('doctor')
    .description('Diagnose environment, integration and every enabled module')
    .action(async () => {
      const { runDoctor } = await import('@cli/commands/doctor');
      process.exitCode = await runDoctor(cwd(), io);
    });
  program
    .command('update')
    .description('Re-apply the integration after upgrading yandecode and migrate yandecode.json')
    .option('--force', 'overwrite managed files even if you edited them')
    .action(async (flags: { force?: boolean }) => {
      const { runUpdate } = await import('@cli/commands/update');
      process.exitCode = runUpdate(cwd(), flags, io);
    });
  program
    .command('uninstall')
    .description('Remove YandeCode from this project')
    .option('--purge', 'also delete .yandecode/ (indexes, memories, logs)')
    .action(async (flags: { purge?: boolean }) => {
      const { runUninstall } = await import('@cli/commands/uninstall');
      process.exitCode = runUninstall(cwd(), flags, io);
    });
  program
    .command('mcp')
    .description('MCP server for Claude Code')
    .command('serve')
    .description('Serve the tools of enabled modules over stdio')
    .action(async () => {
      const { runMcpServe } = await import('@cli/commands/mcp-serve');
      await runMcpServe(cwd());
    });
  program
    .command('hook <event>')
    .description('Claude Code hook entry point (reads the hook JSON from stdin)');

  for (const module of MODULES) module.cli?.(program);
  return program;
}

export async function main(argv: string[]): Promise<void> {
  try {
    await buildProgram().parseAsync(argv);
  } catch (error) {
    const message =
      error instanceof YandeCodeError || error instanceof Error ? error.message : String(error);
    io.err(`yandecode: ${message}\n`);
    process.exitCode = 1;
  }
}
