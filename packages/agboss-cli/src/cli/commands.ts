/**
 * One option schema per command (#198): the parser, `agboss help <command>`, `<command> --help` and the
 * machine description (`agboss help <command> --json`) are all built from it.
 */
import {
  APPLICATION,
  DRY_RUN,
  ENV,
  flag,
  PROFILE,
  START,
  text,
  THREAD,
  type CommandSpec,
} from "./options.js";

import { CHECK_COMMAND } from "./check-command.js";

export { COMMON_OPTIONS, optionsOf, type CommandSpec, type OptionSpec } from "./options.js";
import { EVAL_COMMAND } from "./eval-commands.js";

/** Commands that run one workflow of the application: chosen by its start (#268). */
const START_COMMANDS: Readonly<Record<string, CommandSpec>> = {
  chat: {
    summary: "interactive chat with a workflow of the application",
    usage:
      "agboss chat [--start <name>] [--thread <id>] [--profile <name>] [--env <name>] [--application <path>]",
    options: [START, APPLICATION, THREAD, PROFILE, ENV],
  },
  run: {
    summary: "one execution of a start, the reply to stdout",
    usage:
      'agboss run [--start <name>] ("<task>" | --input <json> | --input-file <file>) [--thread <id>] [--profile <name>] [--env <name>]',
    positionals: "<task…> (a start taking WorkflowStartTextDto)",
    options: [
      START,
      text("input", "<json>", "the start's input as JSON, checked against it field by field"),
      text("input-file", "<file>", "the start's input from a JSON file"),
      APPLICATION,
      THREAD,
      PROFILE,
      ENV,
    ],
  },
  eval: EVAL_COMMAND,
  replay: {
    summary: "re-run a prompt version on recent tasks of a start's workflow",
    usage: "agboss replay [--start <name>] --version <v> [--limit N] [--profile <name>]",
    options: [
      START,
      APPLICATION,
      text("version", "<v>", "the prompt version to replay", { required: true }),
      text("limit", "N", "how many tasks", { default: "100" }),
      PROFILE,
      ENV,
    ],
  },
  golden: {
    summary: "save recent real tasks of a start's workflow as a golden set",
    usage: "agboss golden add [--start <name>] --name <name> [--from-last N]",
    positionals: "add",
    options: [
      START,
      APPLICATION,
      text("name", "<name>", "the set: golden/<workflow>/<name>.yaml", { required: true }),
      text("from-last", "N", "how many recent tasks", { default: "20" }),
      ENV,
    ],
  },
  compare: {
    summary: "profiles side by side on the same tasks of a start's workflow",
    usage: "agboss compare [--start <name>] --profiles base,<p>… [--golden <name> | --last N]",
    options: [
      START,
      APPLICATION,
      text("profiles", "<list>", "comma-separated; the first is the baseline (base = no profile)", {
        required: true,
      }),
      text("golden", "<name>", "the tasks of a golden set"),
      text("last", "N", "or the last N real tasks", { default: "20" }),
      ENV,
    ],
  },
};

/** Commands over the whole application. */
const APPLICATION_COMMANDS: Readonly<Record<string, CommandSpec>> = {
  describe: {
    summary:
      "every workflow: agents, their tools, knowledge bases and settings (no API key needed)",
    usage: "agboss describe [--profile <name>] [--env <name>] [--application <path>] [--json]",
    options: [APPLICATION, PROFILE, ENV],
  },
  check: CHECK_COMMAND,
  dev: {
    summary: "watch mode: the types regenerated and the problems printed on every change",
    usage: "agboss dev [--strict] [--env <name>] [--application <path>]",
    options: [
      APPLICATION,
      flag("strict", "the analyser's warnings are errors, as in agboss check --strict"),
      ENV,
    ],
  },
  studio: {
    summary: "LangGraph Studio on every workflow of the application, children inside their parent",
    usage: "agboss studio [--port N] [--env <name>] [--application <path>]",
    options: [
      APPLICATION,
      text("port", "N", "the port of the local Studio server", { default: "2024" }),
      ENV,
    ],
  },
  rag: {
    summary: "build / update the application's knowledge bases",
    usage: "agboss rag index [--rag <name>] [--env <name>] [--application <path>]",
    positionals: "index",
    options: [APPLICATION, text("rag", "<name>", "only this knowledge base (its full name)"), ENV],
  },
};

const SCAFFOLD_COMMANDS: Readonly<Record<string, CommandSpec>> = {
  create: {
    summary: "a new project from a short questionnaire (alias c)",
    usage:
      'agboss create <name> [--agents "<name>-agent:role,…"] [--tools "<name>-agent:<name>-tool,…"] [--mcp …] [--rag …] [--yes] [--skip-install]',
    positionals: "<name> (the project: <name>-application, its first workflow <name>-workflow)",
    options: [
      text("agents", "<list>", 'full names and roles: "triage-agent:Sorts requests,…"'),
      text("tools", "<list>", 'tools per agent, full names: "answerer-agent:refund-tool,…"'),
      text("mcp", "<spec>", "none | filesystem:<dir> | command:<cmd>:<tool>"),
      text("rag", "<folder>", "none | a folder of notes to search"),
      flag("yes", "no questions: defaults for anything not given", { short: "y" }),
      flag("skip-install", "do not run npm install"),
      DRY_RUN,
    ],
  },
  generate: {
    summary:
      "add a workflow, agent, router, arbiter, tool, MCP server, knowledge base or OpenAPI tools, wired (alias g)",
    usage:
      "agboss generate <workflow|agent|router|arbiter|tool|mcp|rag|openapi> <name> [--workflow <name>] [options]",
    positionals: "<kind> <name> (the full name: billing-agent, refund-tool, policies-rag, …)",
    options: [
      text("workflow", "<name>", "the workflow to add to, by its full name (desk-workflow)"),
      text(
        "agent",
        "<name>",
        "the agent, by its full name, that uses the tool / MCP tool / knowledge base; arbiter: an agent of the launch it judges",
      ),
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
      APPLICATION,
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
  ...START_COMMANDS,
  ...APPLICATION_COMMANDS,
  ...SCAFFOLD_COMMANDS,
};

/** Short names, Angular-style: `agboss c <name>`, `agboss g tool <name>`. */
export const ALIASES: Readonly<Record<string, string>> = { c: "create", g: "generate" };

export const commandName = (given: string): string => ALIASES[given] ?? given;
