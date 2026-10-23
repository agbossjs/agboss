/** `agboss eval run | score | show | calibrate` (#396 S4, #397): one command of subcommands, each its own schema. */
import { APPLICATION, ENV, flag, PROFILE, START, text, type CommandSpec } from "./options.js";

/** `--html <file>`: the run as one self-contained HTML page (#397). */
const HTML = text("html", "<file>", "write the run as one self-contained HTML report to this file");

export const EVAL_COMMAND: CommandSpec = {
  summary:
    "eval suites run on the application (run), a saved run shown (show), its judges against people's labels (calibrate), recorded runs scored with Jev (score)",
  usage: "agboss eval <run|score|show|calibrate> [options]",
  positionals: "run | score | show | calibrate",
  options: [],
  subcommands: {
    run: {
      summary:
        "run an eval suite: every case --runs times, its checks under the cascade, pass@k / pass^k",
      usage:
        "agboss eval run [--suite <name>] [--runs <k>] [--report <run.json>] [--html <file>] [--baseline <run.json> [--fail-on-regression]] [--profile <name>] [--env <name>]",
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
        text("baseline", "<run.json>", "compare each case with this run artifact (a run of main)"),
        flag(
          "fail-on-regression",
          "with --baseline: exit 5 (eval.regressed) when a case stable on the baseline regressed",
        ),
        APPLICATION,
        PROFILE,
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
    calibrate: {
      summary:
        "a saved run's judges against people's labels: Cohen's κ, confusion, disagreements by metric",
      usage: "agboss eval calibrate --report <run.json> [--labels <labels.jsonl>]",
      options: [
        text("report", "<run.json>", "the run artifact whose judges are calibrated", {
          required: true,
        }),
        text(
          "labels",
          "<labels.jsonl>",
          "the labels, one JSON line each (default eval/labels/<suite>.jsonl)",
        ),
      ],
    },
  },
};
