import type * as Vitest from "vitest";
import type { TestContext } from "vitest";
import { faultViolationsOf } from "./invariants/check.js";
import { FaultInvariantError } from "./invariants/violations.js";
import { ATOMIC_FENCING_CASE, checkAtomicFencing } from "./opt-out-check.js";
import { killPods } from "./pod.js";
import { faultSuitePlanOf, type FaultSuiteOptions } from "./fault-suite-plan.js";
import {
  FaultScenarioSkippedError,
  runFaultScenario,
  type RunnableFaultScenario,
} from "./scenario.js";
import type { FaultSabotage } from "./scenarios/sabotages.js";
import { lazyLoad } from "../../infrastructure/clock.js";

export {
  FAULT_SHARD_VARIABLE,
  faultShardOf,
  faultSuitePlanOf,
  type FaultShard,
  type FaultSuiteOptions,
  type FaultSuitePlan,
} from "./fault-suite-plan.js";

/**
 * `faultSuite({ name, storesModule, database })` (#484 AC4): registers the fault scenarios with
 * vitest as `fault suite (<name>)`, one test each, run one after another (their pods spawned,
 * killed and frozen for real). Each resets the database, runs on fresh pods and checks every
 * invariant; every pod it started is killed at its end, whatever happened. Before them, one case
 * fails a set whose fenced-effect or outbound-call store opts out of the atomic lease check (#584).
 * After them (#831) the sabotages: scenarios on the fixture's payment integration broken on
 * purpose, each passing only when the invariant it breaks fails — the suite bites on this set too.
 * What a run leaves out — a scenario `scenarios:` does not name, one of another shard, the
 * sabotages turned off — is a skipped case with its reason, and the first case names the counts:
 * nothing is left out without a trace.
 */

/**
 * vitest, when this module runs in a vitest run. A pod imports this entry outside one (its store
 * set's module, `withHoldPoints`), where vitest cannot be loaded: there `faultSuite` is the only
 * thing missing.
 */
let vitestError: unknown;
const vitest: typeof Vitest | undefined = await lazyLoad(import("vitest")).catch(
  (error: unknown) => {
    vitestError = error;
    return undefined;
  },
);

/** A sabotage's case: the scenario must fail, on its invariant, with its evidence. */
export async function sabotaged(
  sabotage: FaultSabotage,
  options: FaultSuiteOptions,
  expect: Vitest.ExpectStatic,
): Promise<void> {
  const failure: unknown = await runFaultScenario(sabotage, options).then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(failure, `${sabotage.id}: the sabotage passed — the suite does not bite`).toBeInstanceOf(
    FaultInvariantError,
  );
  const error = failure as FaultInvariantError;
  expect(error.invariants, `${sabotage.id}: failed, but not ${sabotage.violates}`).toContain(
    sabotage.violates,
  );
  // the evidence of its own invariant, never another's
  expect(
    error.violations
      .filter((violation) => violation.invariant === sabotage.violates)
      .map((violation) => violation.message),
  ).toContainEqual(expect.stringMatching(sabotage.evidence));
}

/**
 * A scenario's case: it runs and every invariant holds — or, one this set cannot run (#811 AC4: an
 * A2A scenario on a set that keeps no A2A tasks), the case is skipped with the reason.
 */
async function scenarioCase(
  scenario: RunnableFaultScenario,
  options: FaultSuiteOptions,
  expect: Vitest.ExpectStatic,
  context: TestContext,
): Promise<void> {
  const run = await runFaultScenario(scenario, options).catch((error: unknown) => {
    if (error instanceof FaultScenarioSkippedError) context.skip(error.message);
    throw error;
  });
  // checked already (a failure names every violation); the assertion a test makes
  expect(faultViolationsOf(run)).toEqual([]);
}

/** Registers the fault suite on `options`' store set. */
export function faultSuite(options: FaultSuiteOptions): void {
  if (vitest === undefined)
    throw new Error("faultSuite registers vitest tests: call it in a vitest test file", {
      cause: vitestError,
    });
  const { afterEach, describe, expect, it } = vitest;
  const plan = faultSuitePlanOf(options);
  const timeout = options.timeout ?? Math.ceil(300_000 / Math.min(options.timeScale ?? 1, 5));
  describe.sequential(`fault suite (${options.name})`, () => {
    afterEach(() => {
      killPods();
    });
    it(plan.summary, () => {
      // the plan refuses options that run nothing; this case fails if one ever slipped through
      expect(plan.cases.filter((one) => one.skipped === undefined).length).toBeGreaterThan(0);
    });
    it(
      ATOMIC_FENCING_CASE,
      async () => {
        await expect(checkAtomicFencing(options)).resolves.toBeUndefined();
      },
      timeout,
    );
    for (const { scenario, sabotage, skipped } of plan.cases) {
      const title =
        sabotage === undefined
          ? scenario.title
          : `sabotage ${scenario.title}: fails ${sabotage.violates}`;
      if (skipped !== undefined) {
        it(title, (context: TestContext) => {
          context.skip(skipped);
        });
        continue;
      }
      it(
        title,
        (context: TestContext) =>
          sabotage === undefined
            ? scenarioCase(scenario, options, expect, context)
            : sabotaged(sabotage, options, expect),
        timeout,
      );
    }
  });
}
