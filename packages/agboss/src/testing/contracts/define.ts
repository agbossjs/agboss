import { describe, expect, it, type TestContext } from "vitest";
import {
  gatedBody,
  OPT_OUT_SHOWN_CASE,
  shownOptOutBody,
  type FencingGate,
} from "./fencing-gate.js";
import {
  withTarget,
  type ContractCaseBody,
  type ContractTarget,
  type DatabaseTime,
} from "./seam.js";

/**
 * How a published contract suite (#481) is written: its cases as data, grouped as the core's own
 * suites group them, registered with vitest under `<contract> contract (<target name>)` — so a
 * failure in a store's own repository reads the same as in the core.
 */

/** One rule of a contract: its name (as the core's suite names it) and its body. */
export interface ContractCase<TStore> {
  readonly name: string;
  readonly run: ContractCaseBody<TStore>;
  /** Run on real time, the stores deciding by the database's time (#533); absent: the suite's clock. */
  readonly databaseTime?: DatabaseTime;
  /** A case only an atomic lease check passes (#543): behind the suite's fencing gate. */
  readonly isFencing?: boolean;
  /** A case of an optional method (#799): skipped — never passed — for a store without it. */
  readonly optional?: OptionalMethod<TStore>;
}

/** An optional method of a store contract a case checks (`watchQueued`, #777). */
export interface OptionalMethod<TStore> {
  /** Its name, as the skipped case's reason says it. */
  readonly name: string;
  /** Whether `store` has it. */
  readonly isPresent: (store: TStore) => boolean;
  /** What a store without it does instead, for the reason. */
  readonly without: string;
}

/**
 * The body of a case of an optional method (#799): skipped with the reason when neither instance's
 * store has it, failed when only one has — a store either has the method or not —, else run.
 */
const optionalBody =
  <TStore>(
    optional: OptionalMethod<TStore>,
    body: ContractCaseBody<TStore>,
    context: TestContext,
  ): ContractCaseBody<TStore> =>
  async (instances) => {
    const present = [instances.first, instances.second].map(optional.isPresent);
    if (present.every((isPresent) => !isPresent))
      context.skip(`the store has no ${optional.name} (optional): ${optional.without}`);
    expect(present, `${optional.name} on one instance's store only`).toEqual([true, true]);
    await body(instances);
  };

/** Cases registered together; with a `title`, inside a `describe` of their own. */
export interface ContractGroup<TStore> {
  readonly title?: string;
  readonly cases: readonly ContractCase<TStore>[];
  /** Every case of the group is a fencing case (#543). */
  readonly isFencing?: boolean;
}

/** One fast round trip to a store (its `ping()`), as readiness makes it. */
export type StorePing<TStore> = (store: TStore) => Promise<void>;

/** A store contract of #265 (#300): it answers `ping()`. */
export interface PingedStore {
  ping(): Promise<void>;
}

/** The store contracts' own `ping()`. */
export const pingOf = (store: PingedStore): Promise<void> => store.ping();

/** The name of the case every suite ends with: the store answers `ping()` on both instances. */
export const PING_CASE = "ping() resolves on both instances";

const registerCases = <TStore>(
  target: ContractTarget<TStore>,
  group: ContractGroup<TStore>,
  gate: FencingGate<TStore> | undefined,
): void => {
  for (const contractCase of group.cases) {
    const isGated =
      gate !== undefined && (group.isFencing === true || contractCase.isFencing === true);
    const { run, databaseTime, optional } = contractCase;
    if (!isGated && optional === undefined) {
      it(contractCase.name, withTarget(target, run, databaseTime));
      continue;
    }
    it(contractCase.name, (context) => {
      const checked = optional === undefined ? run : optionalBody(optional, run, context);
      const body = isGated ? gatedBody(gate, checked, context) : checked;
      return withTarget(target, body, databaseTime)();
    });
  }
};

/**
 * Registers the suite `<contract> (<target name>)`: every group's cases, then the ping case; the
 * fencing cases behind `gate` when the contract has one (#543), and its opt-out shown when it says.
 */
export function registerContract<TStore>(
  contract: string,
  target: ContractTarget<TStore>,
  groups: readonly ContractGroup<TStore>[],
  ping: StorePing<TStore>,
  gate?: FencingGate<TStore>,
): void {
  describe(`${contract} (${target.name})`, () => {
    for (const group of groups) {
      if (group.title === undefined) registerCases(target, group, gate);
      else
        describe(group.title, () => {
          registerCases(target, group, gate);
        });
    }
    if (gate?.isShown === true) it(OPT_OUT_SHOWN_CASE, withTarget(target, shownOptOutBody(gate)));
    it(
      PING_CASE,
      withTarget(target, async ({ first, second }) => {
        await expect(Promise.all([ping(first), ping(second)])).resolves.toHaveLength(2);
      }),
    );
  });
}
