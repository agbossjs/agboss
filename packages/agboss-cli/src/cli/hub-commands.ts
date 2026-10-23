/** `agboss hub show` (#401): one command of subcommands, each its own schema. */
import { text, type CommandSpec } from "./options.js";

export const HUB_COMMAND: CommandSpec = {
  summary:
    "the agent mesh of many applications from their files — describe snapshots, eval runs, exported executions (show)",
  usage: "agboss hub <show> [options]",
  positionals: "show",
  options: [],
  subcommands: {
    show: {
      summary:
        "read snapshots, eval runs and exported executions from files and folders: the mesh, and with --html one self-contained page — nothing runs",
      usage: "agboss hub show <path…> [--html <file>]",
      positionals: "<path…>",
      options: [
        text("html", "<file>", "write the mesh as one self-contained HTML page to this file"),
      ],
    },
  },
};
