/** `agboss eval run | score | show | calibrate | ui` (#396 S4, #397): one command of subcommands, each its own schema. */
import {
  APPLICATION,
  ENV,
  flag,
  PROFILE,
  START,
  text,
  type CommandSpec,
  type OptionSpec,
} from "./options.js";

/** `--html <file>`: the run as one self-contained HTML page (#397). */
const HTML = text("html", "<file>", "write the run as one self-contained HTML report to this file");

export const EVAL_COMMAND: CommandSpec = {
  summary:
    "eval suites run on the application (run), a saved run shown (show), its judges against people's labels (calibrate), a folder of runs served locally (ui), recorded runs scored with Jev (score)",
  usage: "agboss eval <run|score|show|calibrate|ui> [options]",
  positionals: "run | score | show | calibrate | ui",
  options: [],
  subcommands: {
    run: {
      summary:
        "run an eval suite: every case --runs times, its checks under the cascade, pass@k / pass^k",
      usage:
        "agboss eval run [--suite <name>] [--runs <k>] [--report <run.json>] [--html <file>] [--baseline <run.json> [--fail-on-regression]] [--chaos <rate> --chaos-seed <n> [--chaos-failures <list>]] [--metamorphic] [--profile <name>] [--env <name>]",
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
        text(
          "chaos",
          "<rate>",
          "inject failures into this share of the model calls (0.2); needs --chaos-seed",
        ),
        text(
          "chaos-seed",
          "<n>",
          "the seed of the injected failures: the same seed, the same failures",
        ),
        text(
          "chaos-failures",
          "<list>",
          "what is injected: rate-limited, timeout, truncated-response (default: all)",
        ),
        flag(
          "metamorphic",
          "run each case's variants too: the same tools, the same required calls (check metamorphic)",
        ),
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
    ui: {
      summary:
        "a folder of run artifacts served on 127.0.0.1 behind a token: the runs, each run's report, labels and κ, a run saved as a golden case — nothing runs",
      usage:
        "agboss eval ui [--dir <folder>] [--port N] [--labels-dir <folder>] [--taxonomy <file>] [--labeler <name>] [--application <path>] [--env <name>]",
      options: [
        text("dir", "<folder>", "the folder of run artifacts (*.json)", {
          default: ".agboss/eval",
        }),
        text("port", "N", "the port on 127.0.0.1; 0 for a free one", { default: "4317" }),
        text("labels-dir", "<folder>", "where labels are written, <suite>.jsonl each", {
          default: "eval/labels",
        }),
        text("taxonomy", "<file>", "the failure tags a label may carry", {
          default: "eval/failure-taxonomy.yaml",
        }),
        text("labeler", "<name>", "who labels, as the forms start (default: the system user)"),
        APPLICATION,
        ENV,
      ],
    },
  },
};

/** `agboss generate eval-case`'s own options (#396 PR 8): the suite and the kept execution. */
export const EVAL_CASE_OPTIONS: readonly OptionSpec[] = [
  text("suite", "<name>", "eval-case: the eval suite to add the case to (optional with one)"),
  text("from-execution", "<executionId>", "eval-case: the kept execution the case is drafted from"),
  text("tenant", "<id>", "eval-case: the execution's tenant, when two tenants have the id"),
  ENV,
];
