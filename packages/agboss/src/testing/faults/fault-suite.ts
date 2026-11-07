import type * as Vitest from "vitest";
import type { TestContext } from "vitest";
import { faultViolationsOf } from "./invariants/check.js";
import { FaultInvariantError } from "./invariants/violations.js";
import { ATOMIC_FENCING_CASE, checkAtomicFencing } from "./opt-out-check.js";
import { killPods } from "./pod.js";
import {
  runFaultScenario,
  type FaultScenarioOptions,
  type RunnableFaultScenario,
} from "./scenario.js";
import { SCENARIOS } from "./scenarios/index.js";
import { SABOTAGES, type FaultSabotage } from "./scenarios/sabotages.js";
import { lazyLoad } from "../../infrastructure/clock.js";
import type { Milliseconds } from "../../units/index.js";

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

/** One shard of the suite's cases (#831): `{ index: 2, count: 3 }`, every 3rd from the 2nd. */
export interface FaultShard {
  /** From 1 to `count`. */
  readonly index: number;
  /** How many shards the cases are split over, from 1. */
  readonly count: number;
}

/** The process variable `shard: "env"` reads: `k/n` (`2/3`); unset or empty runs every case. */
export const FAULT_SHARD_VARIABLE = "AGBOSS_FAULT_SHARD";

/** A store set under the fault suite. */
export interface FaultSuiteOptions extends FaultScenarioOptions {
  /** Shown in the suite's title: "PostgreSQL". */
  readonly name: string;
  /**
   * The scenarios and sabotages to run, by id (`s05-zombie-write-refused`); default every one.
   * The others are skipped cases, with the reason.
   */
  readonly scenarios?: readonly string[];
  /**
   * One shard of the cases selected (#831): every `count`-th from the `index`-th, in the suite's
   * order (the scenarios, then the sabotages) — the shards of one count cover each case once.
   * `"env"` reads `AGBOSS_FAULT_SHARD` (`k/n`; unset or empty: every case), as CI's parallel jobs
   * set it. The cases of other shards are skipped, with the reason.
   */
  readonly shard?: FaultShard | "env";
  /**
   * Whether the sabotages run (#831; default `true`): each must fail its invariant on this set.
   * `false` shows them as skipped, with the reason — never as passed.
   */
  readonly sabotages?: boolean;
  /** Each scenario's bound (real time); default 5 minutes at the real clock, less when faster. */
  readonly timeout?: Milliseconds;
}

/** One case of the suite and why it does not run, if it does not. */
interface PlannedCase {
  readonly scenario: RunnableFaultScenario;
  readonly sabotage?: FaultSabotage;
  readonly skipped?: string;
}

/** What `faultSuite` registers: every case, in order, and the line that counts them. */
export interface FaultSuitePlan {
  readonly cases: readonly PlannedCase[];
  readonly summary: string;
}

/** The shard `text` names (`k/n`, 1 ≤ k ≤ n); `undefined` for none, a `RangeError` when malformed. */
export function faultShardOf(text: string | undefined): FaultShard | undefined {
  if (text === undefined || text === "") return undefined;
  const match = /^([1-9]\d*)\/([1-9]\d*)$/u.exec(text);
  const [index, count] = [Number(match?.[1]), Number(match?.[2])];
  if (match === null || index > count)
    throw new RangeError(
      `faultSuite: ${FAULT_SHARD_VARIABLE} is "${text}": expected k/n with 1 ≤ k ≤ n`,
    );
  return { index, count };
}

/** The shard of `options`, checked; `undefined` for none. */
function shardOf(
  shard: FaultSuiteOptions["shard"],
  env: NodeJS.ProcessEnv,
): FaultShard | undefined {
  if (shard === undefined) return undefined;
  if (shard === "env") return faultShardOf(env[FAULT_SHARD_VARIABLE]);
  const { index, count } = shard;
  if (
    !Number.isInteger(count) ||
    count < 1 ||
    !Number.isInteger(index) ||
    index < 1 ||
    index > count
  )
    throw new RangeError(
      `faultSuite: shard ${JSON.stringify(shard)} — whole numbers with 1 ≤ index ≤ count`,
    );
  return { index, count };
}

/** The ids `scenarios:` names, checked: each one a scenario's or a sabotage's. */
function selectedIdsOf(
  ids: readonly string[] | undefined,
  all: readonly RunnableFaultScenario[],
): ReadonlySet<string> | undefined {
  if (ids === undefined) return undefined;
  if (ids.length === 0)
    throw new RangeError(
      "faultSuite: scenarios: [] selects nothing — leave it out to run every case",
    );
  const unknown = ids.filter((id) => !all.some((scenario) => scenario.id === id));
  if (unknown.length > 0)
    throw new RangeError(
      `faultSuite: no scenario ${unknown.join(", ")} — the scenarios are ${all.map((scenario) => scenario.id).join(", ")}`,
    );
  return new Set(ids);
}

/**
 * What `faultSuite` runs on `options` (#831): every scenario, then every sabotage — the ones
 * `scenarios:` does not name, those of other shards (counted over the ones selected) and, with
 * `sabotages: false`, the sabotages skipped with the reason. Malformed options are a `RangeError`.
 */
export function faultSuitePlanOf(
  options: FaultSuiteOptions,
  env: NodeJS.ProcessEnv = process.env,
): FaultSuitePlan {
  const sabotages: unknown = options.sabotages ?? true;
  if (typeof sabotages !== "boolean")
    throw new RangeError(`faultSuite: sabotages is ${String(sabotages)} — true or false`);
  const all: readonly RunnableFaultScenario[] = [...SCENARIOS, ...SABOTAGES];
  const selected = selectedIdsOf(options.scenarios, all);
  const shard = shardOf(options.shard, env);
  let position = 0;
  const cases = all.map((scenario): PlannedCase => {
    const sabotage = SABOTAGES.find((one) => one.id === scenario.id);
    const own = sabotage === undefined ? { scenario } : { scenario, sabotage };
    if (selected !== undefined && !selected.has(scenario.id))
      return { ...own, skipped: "not selected: scenarios: names others" };
    if (sabotage !== undefined && !sabotages)
      return {
        ...own,
        skipped: "sabotages: false — whether the suite bites on this set is not checked",
      };
    position += 1;
    if (shard !== undefined && (position - 1) % shard.count !== shard.index - 1)
      return {
        ...own,
        skipped: `in another shard than ${String(shard.index)}/${String(shard.count)}`,
      };
    return own;
  });
  // a shard that runs nothing would be green: more shards than cases is refused (#831)
  if (shard !== undefined && shard.count > position)
    throw new RangeError(
      `faultSuite: ${String(shard.count)} shards of ${String(position)} cases — some shard would run nothing`,
    );
  const runs = cases.filter((one) => one.skipped === undefined);
  if (runs.length === 0)
    throw new RangeError(
      "faultSuite: the options leave no case to run (sabotages: false with only sabotages selected)",
    );
  const counted = (isSabotage: boolean): number =>
    runs.filter((one) => (one.sabotage !== undefined) === isSabotage).length;
  const how = [
    ...(selected === undefined ? [] : ["selected by scenarios:"]),
    ...(shard === undefined ? [] : [`shard ${String(shard.index)}/${String(shard.count)}`]),
    ...(sabotages ? [] : ["sabotages: false"]),
  ];
  const summary = `runs ${String(runs.length)} of ${String(all.length)} cases: ${String(counted(false))} of ${String(SCENARIOS.length)} scenarios, ${String(counted(true))} of ${String(SABOTAGES.length)} sabotages${how.length === 0 ? "" : ` (${how.join(", ")})`}`;
  return { cases, summary };
}

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
        async () => {
          if (sabotage !== undefined) {
            await sabotaged(sabotage, options, expect);
            return;
          }
          const run = await runFaultScenario(scenario, options);
          // checked already (a failure names every violation); the assertion a test makes
          expect(faultViolationsOf(run)).toEqual([]);
        },
        timeout,
      );
    }
  });
}
