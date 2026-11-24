import { flag, type CommandSpec } from "./options.js";

/** `agboss explain <code>` (#1325c): needs no application. */
export const EXPLAIN_COMMAND: CommandSpec = {
  summary: "what an assembly rule, check code or error code means, and how to fix it",
  usage: "agboss explain <code> [--json]    |    agboss explain --list",
  positionals: "<code>",
  options: [flag("list", "list every code that can be explained")],
};
