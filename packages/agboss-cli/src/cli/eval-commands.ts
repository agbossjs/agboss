/** `agboss eval run | score` (#396 S4): one command of two subcommands, each its own schema. */
import { APPLICATION, ENV, PROFILE, START, text, type CommandSpec } from "./options.js";

export const EVAL_COMMAND: CommandSpec = {
  summary: "eval suites run on the application (run), recorded runs scored with Jev (score)",
  usage: "agboss eval <run|score> [options]",
  positionals: "run | score",
  options: [],
  subcommands: {
    run: {
      summary:
        "run an eval suite: every case --runs times, its checks under the cascade, pass@k / pass^k",
      usage:
        "agboss eval run [--suite <name>] [--runs <k>] [--report <run.json>] [--env <name>] [--application <path>]",
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
  },
};
