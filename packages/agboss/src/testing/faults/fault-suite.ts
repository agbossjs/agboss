import type * as Vitest from "vitest";
import { faultViolationsOf } from "./invariants/check.js";
import { ATOMIC_FENCING_CASE, checkAtomicFencing } from "./opt-out-check.js";
import { killPods } from "./pod.js";
import { runFaultScenario, type FaultScenario, type FaultScenarioOptions } from "./scenario.js";
import { FAULT_SCENARIOS } from "./scenarios/index.js";
import { lazyLoad } from "../../infrastructure/clock.js";

/**
 * `faultSuite({ name, stores, database })` (#484 AC4): registers the fault scenarios with vitest
 * as `fault suite (<name>)`, one test each, run one after another (their pods spawned, killed and
 * frozen for real). Each resets the database, runs on fresh pods and checks every invariant;
 * every pod it started is killed at its end, whatever happened. Before them, one case fails a set
 * whose fenced-effect or outbound-call store opts out of the atomic lease check (#584).
 */

/**
 * vitest, when this module runs in a vitest run. A pod imports this entry outside one (its store
 * set's module, `withHoldPoints`), where vitest cannot be loaded: there `faultSuite` is the only
 * thing missing.
 */
const vitest: typeof Vitest | undefined = await lazyLoad(import("vitest")).catch(() => undefined);

/** A store set under the fault suite. */
export interface FaultSuiteOptions extends FaultScenarioOptions {
  /** Shown in the suite's title: "PostgreSQL". */
  readonly name: string;
  /** The scenarios to run, by id (`s05-zombie-write-refused`); default every one. */
  readonly scenarios?: readonly string[];
  /** Each scenario's bound (real time, ms); default 5 minutes at the real clock, less when faster. */
  readonly timeout?: number;
}

/** The scenarios `ids` select, in the suite's order; an unknown id is a `RangeError`. */
export function selectedScenarios(ids: readonly string[] | undefined): readonly FaultScenario[] {
  if (ids === undefined) return FAULT_SCENARIOS;
  const unknown = ids.filter((id) => !FAULT_SCENARIOS.some((scenario) => scenario.id === id));
  if (unknown.length > 0)
    throw new RangeError(
      `faultSuite: no scenario ${unknown.join(", ")} — the scenarios are ${FAULT_SCENARIOS.map((scenario) => scenario.id).join(", ")}`,
    );
  return FAULT_SCENARIOS.filter((scenario) => ids.includes(scenario.id));
}

/** Registers the fault suite on `options`' store set. */
export function faultSuite(options: FaultSuiteOptions): void {
  if (vitest === undefined)
    throw new Error("faultSuite registers vitest tests: call it in a vitest test file");
  const { afterEach, describe, expect, it } = vitest;
  const scenarios = selectedScenarios(options.scenarios);
  const timeout = options.timeout ?? Math.ceil(300_000 / Math.min(options.timeScale ?? 1, 5));
  describe.sequential(`fault suite (${options.name})`, () => {
    afterEach(() => {
      killPods();
    });
    it(
      ATOMIC_FENCING_CASE,
      async () => {
        await expect(checkAtomicFencing(options)).resolves.toBeUndefined();
      },
      timeout,
    );
    for (const scenario of scenarios)
      it(
        scenario.title,
        async () => {
          const run = await runFaultScenario(scenario, options);
          // checked already (a failure names every violation); the assertion a test makes
          expect(faultViolationsOf(run)).toEqual([]);
        },
        timeout,
      );
  });
}
