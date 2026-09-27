import type { WorkspacePaths, YandeCodeConfig } from '@yandecode/core';
import type { Command } from 'commander';
import type { ZodRawShape } from 'zod';

/** Claude Code hook events a module may subscribe to. */
export const HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'Stop',
  'SubagentStop',
  'PreCompact',
  'SessionEnd',
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

/** One hook subscription materialized into .claude/settings.json. */
export interface HookBinding {
  event: HookEvent;
  /** Tool-name matcher for PreToolUse/PostToolUse (regex alternation, e.g. "Write|Edit"). */
  matcher?: string;
}

/** The subset of Claude Code's hook payload modules read. Unknown fields are preserved. */
export interface HookInput {
  session_id?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
  reason?: string;
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: unknown;
  [key: string]: unknown;
}

export type HookResult =
  | { kind: 'none' }
  /** Text added to the model's context (SessionStart, UserPromptSubmit, PreToolUse, PostToolUse). */
  | { kind: 'context'; text: string }
  /** PreToolUse only: block the call and tell the model why / what to do instead. */
  | { kind: 'deny'; reason: string };

/** Lazily opened services shared by all modules of one process. */
export interface ModuleContext {
  root: string;
  paths: WorkspacePaths;
  config: YandeCodeConfig;
  /** This module's own section of yandecode.json (already defaulted by the module). */
  settings: Record<string, unknown>;
  /** Append a structured line to .yandecode/logs/<module>.jsonl. */
  log(event: string, data?: Record<string, unknown>): void;
}

export type HookHandler = (input: HookInput, ctx: ModuleContext) => Promise<HookResult>;

export interface ToolResult {
  text: string;
  isError?: boolean;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  ctx: ModuleContext,
) => Promise<ToolResult>;

/** Declared up front so the MCP host can list tools without loading the module. */
export interface ToolSpec {
  name: string;
  /** Short human title (MCP `title`), e.g. "Find code". */
  title: string;
  /** Starts with the intent it serves and what it replaces; mechanics come after. */
  description: string;
  inputSchema: ZodRawShape;
}

/**
 * One line of the routing table the agent receives (MCP instructions, routing skill): for this
 * intent, call this tool instead of the built-in habit. Agents keep their grep/cat/Bash habits
 * unless told, at the right moment, which tool fits which intent (pacolang A/B, 2026-09-26).
 */
export interface RoutingRule {
  /** What the agent is trying to do, phrased as the agent would think it. */
  intent: string;
  /** The tool to call (bare name, e.g. `code_search`), optionally with an argument hint. */
  use: string;
  /** The built-in habit it replaces, e.g. "grep -rn / rg / find". */
  insteadOf: string;
}

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail' | 'skip';
  detail: string;
  fix?: string;
}

/** The heavy part of a module, imported only when one of its tools/hooks/commands runs. */
export interface ModuleRuntime {
  tools?: Record<string, ToolHandler>;
  hooks?: Partial<Record<HookEvent, HookHandler>>;
  doctor?: (ctx: ModuleContext) => Promise<DoctorCheck[]>;
  /** Release long-lived resources (language servers, DB handles). */
  dispose?: () => Promise<void>;
}

export interface ModuleDefinition {
  id: string;
  title: string;
  /** One line shown by `init` and `modules list`. */
  summary: string;
  requires: readonly string[];
  defaultEnabled: boolean;
  /** One or two lines for the managed CLAUDE.md block: when the agent should use this module. */
  guidance?: string;
  /** Intent → tool rules composed into the MCP instructions and the routing skill. */
  routing?: readonly RoutingRule[];
  /** Human-readable external requirements (e.g. "npm registry access on first use"). */
  requirements?: readonly string[];
  hooks: readonly HookBinding[];
  tools?: readonly ToolSpec[];
  /** Skill directory names shipped in @yandecode/plugin/skills. */
  skills: readonly string[];
  /** Agent file names (without .md) shipped in @yandecode/plugin/agents. */
  agents: readonly string[];
  /** Registers `yandecode <module-id> …` subcommands; actions must load the runtime lazily. */
  cli?: (program: Command) => void;
  load: () => Promise<ModuleRuntime>;
}
