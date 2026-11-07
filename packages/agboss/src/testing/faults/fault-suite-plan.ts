import type { FaultScenarioOptions, RunnableFaultScenario } from "./scenario.js";
import { SCENARIOS } from "./scenarios/index.js";
import { SABOTAGES, type FaultSabotage } from "./scenarios/sabotages.js";
import type { Milliseconds } from "../../units/index.js";

/**
 * What a fault suite runs (#831): the options, the shard, and the plan of every case — run, or left
 * out with the reason — that `faultSuite` registers.
 */

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

/** What the options say of the cases, as `leftOutOf` reads them. */
interface Selection {
  readonly selected: ReadonlySet<string> | undefined;
  readonly sabotages: boolean;
  readonly shard: FaultShard | undefined;
}

/** Why `scenario` is left out before shards are counted: not selected, or a sabotage turned off. */
function leftOutOf(
  scenario: RunnableFaultScenario,
  sabotage: FaultSabotage | undefined,
  { selected, sabotages }: Selection,
): string | undefined {
  if (selected !== undefined && !selected.has(scenario.id))
    return "not selected: scenarios: names others";
  if (sabotage !== undefined && !sabotages)
    return "sabotages: false — whether the suite bites on this set is not checked";
  return undefined;
}

/** Whether the `position`-th case kept (from 1) is in `shard`: every `count`-th from `index`. */
const isInShard = (position: number, shard: FaultShard | undefined): boolean =>
  shard === undefined || (position - 1) % shard.count === shard.index - 1;

/** The first case's title: what runs of what there is, and what narrowed it. */
function summaryOf(runs: readonly PlannedCase[], total: number, shown: Selection): string {
  const counted = (isSabotage: boolean): number =>
    runs.filter((one) => (one.sabotage !== undefined) === isSabotage).length;
  const { selected, shard, sabotages } = shown;
  const how = [
    ...(selected === undefined ? [] : ["selected by scenarios:"]),
    ...(shard === undefined ? [] : [`shard ${String(shard.index)}/${String(shard.count)}`]),
    ...(sabotages ? [] : ["sabotages: false"]),
  ];
  const narrowed = how.length === 0 ? "" : ` (${how.join(", ")})`;
  return `runs ${String(runs.length)} of ${String(total)} cases: ${String(counted(false))} of ${String(SCENARIOS.length)} scenarios, ${String(counted(true))} of ${String(SABOTAGES.length)} sabotages${narrowed}`;
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
  const shown = { selected, sabotages, shard };
  let position = 0;
  const cases = all.map((scenario): PlannedCase => {
    const sabotage = SABOTAGES.find((one) => one.id === scenario.id);
    const own = sabotage === undefined ? { scenario } : { scenario, sabotage };
    const left = leftOutOf(scenario, sabotage, shown);
    if (left !== undefined) return { ...own, skipped: left };
    position += 1;
    return isInShard(position, shard)
      ? own
      : {
          ...own,
          skipped: `in another shard than ${String(shard?.index)}/${String(shard?.count)}`,
        };
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
  const summary = summaryOf(runs, all.length, shown);
  return { cases, summary };
}
