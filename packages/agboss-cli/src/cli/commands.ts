/**
 * One option schema per command (#198): the parser, `agboss help <command>`, `<command> --help` and the
 * machine description (`agboss help <command> --json`) are all built from it.
 */
import {
  DRY_RUN,
  ENV,
  flag,
  PROFILE,
  text,
  THREAD,
  WORKFLOW,
  type CommandSpec,
} from "./options.js";

export { COMMON_OPTIONS, optionsOf, type CommandSpec, type OptionSpec } from "./options.js";

const WORKFLOW_COMMANDS: Readonly<Record<string, CommandSpec>> = {
  chat: {
    summary: "interactive chat with the workflow",
    usage: "agboss chat --workflow <path> [--thread <id>] [--profile <name>] [--env <name>]",
    options: [WORKFLOW, THREAD, PROFILE, ENV],
  },
  run: {
    summary: "one task, the reply to stdout",
    usage:
      'agboss run --workflow <path> [--thread <id>] [--profile <name>] [--env <name>] "<task>"',
    positionals: "<task…> (or the old form: <workflow.ts> <task…>)",
    options: [
      WORKFLOW,
      text("input", "<text>", "the task (instead of the positional words)"),
      THREAD,
      PROFILE,
      ENV,
    ],
  },
  describe: {
    summary: "agents, their tools, knowledge bases and settings (no API key needed)",
    usage: "agboss describe --workflow <path> [--profile <name>] [--env <name>] [--json]",
    options: [WORKFLOW, PROFILE, ENV],
  },
  check: {
    summary:
      "every validation that needs no API key: assembly, graph rules, environment, prompts (+ models)",
    usage:
      "agboss check --workflow <path> [--models] [--strict] [--profile <name>] [--env <name>] [--json]",
    options: [
      WORKFLOW,
      flag("models", "also check models against their providers (lists them over the network)"),
      flag("strict", "the analyser's warnings are errors ([flow.path-too-deep], …)"),
      flag("prompts", "prompts: files exist, every {{variable}} is known — always checked"),
      PROFILE,
      ENV,
    ],
  },
  eval: {
    summary: "score recent runs with Jev",
    usage: "agboss eval --workflow <path> [--version <v>] [--limit N] [--profile <name>]",
    options: [
      WORKFLOW,
      text("version", "<v>", "only runs of this prompt version"),
      text("limit", "N", "how many runs", { default: "100" }),
      PROFILE,
      ENV,
    ],
  },
  replay: {
    summary: "re-run a prompt version on recent tasks",
    usage: "agboss replay --workflow <path> --version <v> [--limit N] [--profile <name>]",
    options: [
      WORKFLOW,
      text("version", "<v>", "the prompt version to replay", { required: true }),
      text("limit", "N", "how many tasks", { default: "100" }),
      PROFILE,
      ENV,
    ],
  },
  golden: {
    summary: "save recent real tasks as a golden set",
    usage: "agboss golden add --workflow <path> --name <name> [--from-last N]",
    positionals: "add",
    options: [
      WORKFLOW,
      text("name", "<name>", "the set: golden/<workflow>/<name>.yaml", { required: true }),
      text("from-last", "N", "how many recent tasks", { default: "20" }),
      ENV,
    ],
  },
  compare: {
    summary: "profiles side by side on the same tasks",
    usage: "agboss compare --workflow <path> --profiles base,<p>… [--golden <name> | --last N]",
    options: [
      WORKFLOW,
      text("profiles", "<list>", "comma-separated; the first is the baseline (base = no profile)", {
        required: true,
      }),
      text("golden", "<name>", "the tasks of a golden set"),
      text("last", "N", "or the last N real tasks", { default: "20" }),
      ENV,
    ],
  },
  "rag:index": {
    summary: "build / update the workflow's knowledge bases",
    usage: "agboss rag:index --workflow <path> [--kb <name>] [--env <name>]",
    options: [WORKFLOW, text("kb", "<name>", "only this knowledge base"), ENV],
  },
};

const SCAFFOLD_COMMANDS: Readonly<Record<string, CommandSpec>> = {
  create: {
    summary: "a new project from a short questionnaire (alias c)",
    usage:
      'agboss create <name> [--agents "a:role,…"] [--tools "a:tool,…"] [--mcp …] [--rag …] [--yes] [--skip-install]',
    positionals: "<name>",
    options: [
      text("agents", "<list>", 'agents and roles: "triage:Sorts requests,answerer:Answers"'),
      text("tools", "<list>", 'tools per agent: "answerer:search_orders,answerer:refund"'),
      text("mcp", "<spec>", "none | filesystem:<dir> | command:<cmd>:<tool>"),
      text("rag", "<folder>", "none | a folder of notes to search"),
      flag("yes", "no questions: defaults for anything not given", { short: "y" }),
      flag("skip-install", "do not run npm install"),
      DRY_RUN,
    ],
  },
  generate: {
    summary:
      "add a workflow, agent, router, tool, MCP server, knowledge base or OpenAPI tools, wired (alias g)",
    usage:
      "agboss generate <workflow|agent|router|tool|mcp|rag|openapi> <name> [--workflow <path>] [options]",
    positionals: "<kind> <name>",
    options: [
      text("workflow", "<path>", "the workflow to add to (src/<name>/<name>.workflow.ts)"),
      text("agent", "<name>", "the agent that uses the tool / MCP tool / knowledge base"),
      text("description", "<text>", "an agent's role, or what a router decides"),
      text("dir", "<folder>", "mcp: a filesystem server over this folder"),
      text("command", "<cmd>", "mcp: a server started with this command (with --tool <name>)"),
      text("tool", "<name>", "mcp: the server's tool"),
      text("folder", "<dir>", "rag: the folder of notes"),
      text(
        "url",
        "<file|url>",
        "openapi: the OpenAPI 3 document — one tool per operation (with --agent)",
      ),
      text("operations", "<ids>", "openapi: only these operations (operationIds, comma-separated)"),
      flag(
        "force",
        "regenerate files that exist; the wiring in them (tools, rag, routes, …) is kept and reported, never doubled",
      ),
      flag("reset", "with --force: overwrite files that exist as generated, dropping their wiring"),
      DRY_RUN,
    ],
  },
  migrate: {
    summary: "rewrite imports of the old entries (agboss/core, /graph, …) to the new ones",
    usage: "agboss migrate imports [<path>…] [--dry-run]",
    positionals: "imports [<path>…]",
    options: [DRY_RUN],
  },
  help: {
    summary: "this list, or one command's options",
    usage: "agboss help [<command>] [--json]",
    positionals: "[<command>]",
    options: [],
  },
};

export const COMMANDS: Readonly<Record<string, CommandSpec>> = {
  ...WORKFLOW_COMMANDS,
  ...SCAFFOLD_COMMANDS,
};

/** Short names, Angular-style: `agboss c <name>`, `agboss g tool <name>`. */
export const ALIASES: Readonly<Record<string, string>> = { c: "create", g: "generate" };

export const commandName = (given: string): string => ALIASES[given] ?? given;
