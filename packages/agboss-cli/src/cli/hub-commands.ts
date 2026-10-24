/** `agboss hub show` (#401): one command of subcommands, each its own schema. */
import { text, type CommandSpec } from "./options.js";

export const HUB_COMMAND: CommandSpec = {
  summary:
    "the agent mesh of many applications from their files — describe snapshots, eval runs, exported executions (show), served locally (ui)",
  usage: "agboss hub <show|ui> [options]",
  positionals: "show | ui",
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
    ui: {
      summary:
        "the same files served on 127.0.0.1 behind a token: the mesh, a search of the kept executions, a JSON API — read-only, nothing runs",
      usage: "agboss hub ui <path…> [--port N]",
      positionals: "<path…>",
      options: [text("port", "N", "the port on 127.0.0.1; 0 for a free one", { default: "4318" })],
    },
  },
};
