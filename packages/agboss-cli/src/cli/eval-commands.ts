/** `agboss eval run | score | show` (#396 S4, #397): one command of subcommands, each its own schema. */
import { APPLICATION, ENV, PROFILE, START, text, type CommandSpec } from "./options.js";

/** `--html <file>`: the run as one self-contained HTML page (#397). */
const HTML = text("html", "<file>", "write the run as one self-contained HTML report to this file");

export const EVAL_COMMAND: CommandSpec = {
  summary:
    "eval suites run on the application (run), a saved run shown (show), recorded runs scored with Jev (score)",
  usage: "agboss eval <run|score|show> [options]",
  positionals: "run | score | show",
  options: [],
  subcommands: {
    run: {
      summary:
        "run an eval suite: every case --runs times, its checks under the cascade, pass@k / pass^k",
      usage:
        "agboss eval run [--suite <name>] [--runs <k>] [--report <run.json>] [--html <file>] [--env <name>] [--application <path>]",
      options: [
        text(
          "suite",
          "<name>",
          "the @EvalSuite, by its full name (refunds-eval-suite); optional with one suite",
        ),
        text("runs", "<k>", "how many times each case runs: the k of pass@k / pass^k", {
          default: "1",
        }),
        text("report", "<run.json>", "write the run artifact (agboss.eval-run) to this file"),
        HTML,
        APPLICATION,
        ENV,
      ],
    },
    score: {
      summary: "score recent runs of a start's workflow with Jev",
      usage: "agboss eval score [--start <name>] [--version <v>] [--limit N] [--profile <name>]",
      options: [
        START,
        APPLICATION,
        text("version", "<v>", "only runs of this prompt version"),
        text("limit", "N", "how many runs", { default: "100" }),
        PROFILE,
        ENV,
      ],
    },
    show: {
      summary: "a saved run artifact: its table, and with --html its HTML report — nothing runs",
      usage: "agboss eval show <run.json> [--html <file>]",
      positionals: "<run.json>",
      options: [HTML],
    },
  },
};
