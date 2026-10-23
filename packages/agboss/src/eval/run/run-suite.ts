import type { BuiltApplication } from "../../application/create-app.js";
import type { ChaosOptions } from "../chaos/chaos-failure.js";
import { modelChaosOf } from "../chaos/model-chaos.js";
import { startsOfApplication } from "../../application/application-starts.js";
import type { Class } from "../../components/injection.js";
import { workflowIdentityOf } from "../../flow/runtime/workflow-keys.js";
import { checkEvalSuite } from "../suite/check-suite.js";
import type { EvalCase } from "../suite/cases.js";
import { caseHashOf } from "./case-hash.js";
import { caseExpectationOf } from "./expectation.js";
import { ranOnOf } from "./ran-on.js";
import { runCaseOnce, type SuiteRunParts } from "./case-run.js";
import {
  caseReportOf,
  EVAL_RUN_KIND,
  EVAL_RUN_SCHEMA_VERSION,
  summaryOf,
  type EvalCaseReport,
  type EvalRunReport,
  type EvalRunResult,
} from "./report.js";

/**
 * `agboss eval run` (#396 PR 2): an `@EvalSuite` on a built application instance — checked first
 * (`checkEvalSuite`: its rules, its cases' values), then every case run `runs` times, one after the
 * other, each run on a thread of its own — into the run artifact (`EvalRunReport`).
 */

/** How a suite is run. */
export interface EvalRunOptions {
  /** How many times each case runs: the k of pass@k / pass^k (n = k, S2 Q6). */
  readonly runs: number;
  /**
   * The chaos the application was built with (`AppOptions.chaos`, the same object, #396 PR 6): what
   * it injected goes into the artifact's `chaos`.
   */
  readonly chaos?: ChaosOptions;
  /** Told after each run, in order (the CLI prints progress). */
  readonly onRun?: (name: string, result: EvalRunResult) => void;
  /** The profile the application was built on (`--profile`), for the artifact's header. */
  readonly profile?: string;
}

/** The parts every run of the suite shares. */
function partsOf(built: BuiltApplication, suite: Class): SuiteRunParts {
  const { application } = built.assembled;
  const meta = checkEvalSuite(application, suite);
  const start = startsOfApplication(application).find((found) => found.component === meta.start);
  const workflow = built.workflows.find((found) => found.deps.config.name === start?.workflow);
  // checkEvalSuite refuses a start the application does not have ([eval.unknown-start])
  if (start === undefined || workflow === undefined)
    throw new Error(`${meta.name}: its start is not built in ${built.assembled.name}`);
  const { idGenerator } = built.infrastructure;
  const newThreadId = (): string => idGenerator.newThreadId();
  return {
    app: built.app,
    deps: workflow.deps,
    bundle: workflow.bundle,
    start,
    suite: meta,
    newThreadId,
  };
}

async function caseReport(
  parts: SuiteRunParts,
  written: EvalCase,
  options: EvalRunOptions,
): Promise<EvalCaseReport> {
  const results: EvalRunResult[] = [];
  for (let run = 1; run <= options.runs; run += 1) {
    const result = await runCaseOnce(parts, written, run);
    options.onRun?.(written.name, result);
    results.push(result);
  }
  const hash = caseHashOf(written, parts.suite.checks, parts.suite.cascade);
  const mask = parts.deps.pii?.observability;
  const expectation = await caseExpectationOf(written, parts.suite.checks, mask);
  return { ...caseReportOf(written.name, hash, results), expectation };
}

/** Runs a suite on an application instance: its artifact. */
export async function runEvalSuite(
  built: BuiltApplication,
  suite: Class,
  options: EvalRunOptions,
): Promise<EvalRunReport> {
  if (!Number.isInteger(options.runs) || options.runs < 1)
    throw new RangeError(`runs: a whole number from 1, got ${String(options.runs)}`);
  const parts = partsOf(built, suite);
  const { clock } = built.infrastructure;
  const startedAt = clock.now().toISOString();
  const cases: EvalCaseReport[] = [];
  for (const written of parts.suite.cases) cases.push(await caseReport(parts, written, options));
  const { config } = parts.deps;
  const spent = cases.flatMap((found) => found.runResults).reduce((sum, r) => sum + r.spentUsd, 0);
  return {
    kind: EVAL_RUN_KIND,
    schemaVersion: EVAL_RUN_SCHEMA_VERSION,
    suite: parts.suite.name,
    application: { name: built.assembled.name, version: built.assembled.version },
    workflow: { name: config.name, version: config.version },
    configHash: workflowIdentityOf(parts.deps).configHash,
    start: parts.start.name,
    environment: parts.deps.contexts?.application.environmentName ?? "dev",
    runs: options.runs,
    cascade: parts.suite.cascade,
    startedAt,
    endedAt: clock.now().toISOString(),
    cases,
    summary: summaryOf(cases),
    spend: { totalUsd: spent },
    ...ranOnOf(parts.bundle, options.profile),
    ...(options.chaos === undefined ? {} : { chaos: modelChaosOf(options.chaos).summary() }),
  };
}
