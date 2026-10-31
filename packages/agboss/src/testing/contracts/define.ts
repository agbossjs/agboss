import { describe, expect, it } from "vitest";
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
}

/** Cases registered together; with a `title`, inside a `describe` of their own. */
export interface ContractGroup<TStore> {
  readonly title?: string;
  readonly cases: readonly ContractCase<TStore>[];
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
  cases: readonly ContractCase<TStore>[],
): void => {
  for (const contractCase of cases)
    it(contractCase.name, withTarget(target, contractCase.run, contractCase.databaseTime));
};

/** Registers the suite `<contract> (<target name>)`: every group's cases, then the ping case. */
export function registerContract<TStore>(
  contract: string,
  target: ContractTarget<TStore>,
  groups: readonly ContractGroup<TStore>[],
  ping: StorePing<TStore>,
): void {
  describe(`${contract} (${target.name})`, () => {
    for (const group of groups) {
      if (group.title === undefined) registerCases(target, group.cases);
      else
        describe(group.title, () => {
          registerCases(target, group.cases);
        });
    }
    it(
      PING_CASE,
      withTarget(target, async ({ first, second }) => {
        await expect(Promise.all([ping(first), ping(second)])).resolves.toHaveLength(2);
      }),
    );
  });
}
