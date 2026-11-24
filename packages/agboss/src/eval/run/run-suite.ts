import { usd, type Usd } from "../../units/index.js";
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
import { ranOnOf, type EvalModelUse } from "./ran-on.js";
import { judgeUseOf } from "./judge-check.js";
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
   * The chaos the application was built with (`builtApplicationOf`'s, the same object, #396 PR 6): what
   * it injected goes into the artifact's `chaos`.
   */
  readonly chaos?: ChaosOptions;
  /**
   * `--metamorphic` (#396 PR 7): every case's `variants` run too — the same tools, the same
   * required calls — as the check `metamorphic`, after the suite's checks.
   */
  readonly metamorphic?: boolean;
  /** Told after each run, in order (the CLI prints progress). */
  readonly onRun?: (name: string, result: EvalRunResult) => void;
  /** The profile the application was built on (`--profile`), for the artifact's header. */
  readonly profile?: string;
}

/** The parts every run of the suite shares. */
function partsOf(built: BuiltApplication, suite: Class, isMetamorphic: boolean): SuiteRunParts {
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
    isMetamorphic,
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
  const isMetamorphic = parts.isMetamorphic === true;
  const hash = caseHashOf(written, parts.suite, parts.suite.cascade, isMetamorphic);
  const mask = parts.deps.pii?.observability;
  const expectation = await caseExpectationOf(written, parts.suite, mask, isMetamorphic);
  return { ...caseReportOf(written.name, hash, results), expectation };
}

/** Every model judge the suite runs, once, with the provider it is pinned to. */
function judgesOf(parts: SuiteRunParts): readonly EvalModelUse[] {
  const judges = new Set([
    ...parts.suite.judges,
    ...parts.suite.cases.flatMap((written) => written.judges ?? []),
  ]);
  return [...judges].flatMap((judge) => {
    const used = judgeUseOf(parts.deps, judge, parts.suite.modelProvider);
    return used === undefined ? [] : [used];
  });
}

/** Runs a suite on an application instance: its artifact. */
export async function runEvalSuite(
  built: BuiltApplication,
  suite: Class,
  options: EvalRunOptions,
): Promise<EvalRunReport> {
  if (!Number.isInteger(options.runs) || options.runs < 1)
    throw new RangeError(`runs: a whole number from 1, got ${String(options.runs)}`);
  const parts = partsOf(built, suite, options.metamorphic === true);
  const { clock } = built.infrastructure;
  const startedAt = clock.now();
  const cases: EvalCaseReport[] = [];
  for (const written of parts.suite.cases) cases.push(await caseReport(parts, written, options));
  const { config } = parts.deps;
  const results = cases.flatMap((found) => found.runResults);
  const sumOf = (pick: (result: EvalRunResult) => number): Usd =>
    usd(results.reduce((sum, result) => sum + pick(result), 0));
  const spend = {
    executionUsd: sumOf((result) => result.executionUsd),
    judgeUsd: sumOf((result) => result.judgeUsd),
    totalUsd: sumOf((result) => result.totalUsd),
  };
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
    endedAt: clock.now(),
    cases,
    summary: summaryOf(cases),
    spend,
    ...ranOnOf(parts.bundle, options.profile),
    judges: judgesOf(parts),
    ...(options.chaos === undefined ? {} : { chaos: modelChaosOf(options.chaos).summary() }),
    ...(options.metamorphic === true ? { metamorphic: true } : {}),
  };
}
