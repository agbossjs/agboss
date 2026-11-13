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
} from "./instance-context.js";
import { isStoreCapability, StoreCapability } from "./store-capability.js";
import { StoreConformanceError } from "./store-conformance-check.js";

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
  /**
   * A case of an optional capability (#799, #831): run when the target declares it, skipped — never
   * passed — when it does not and the store lacks it, failed when the two disagree.
   */
  readonly capability?: CapabilityCheck<TStore>;
}

/** An optional capability of a store contract a case checks (`watchQueued`, #777). */
export interface CapabilityCheck<TStore> {
  readonly capability: StoreCapability;
  /** Whether `store` has it. */
  readonly isPresent: (store: TStore) => boolean;
  /** What a store without it does instead, for the reason. */
  readonly without: string;
}

/** Each capability as a message names it (`StoreCapability.WatchQueued`). */
const CAPABILITY_NAMES: Readonly<Record<StoreCapability, string>> = {
  [StoreCapability.WatchQueued]: "StoreCapability.WatchQueued",
  [StoreCapability.LatestByStep]: "StoreCapability.LatestByStep",
};

/** `StoreCapability.WatchQueued`, as a message names it. */
const capabilityName = (capability: StoreCapability): string => CAPABILITY_NAMES[capability];

/**
 * The body of a case of an optional capability (#831): what the target declares decides. Not
 * declared — the store must not have it (else it fails: declare it), and the case is skipped with
 * the reason; declared — both instances' stores must have it, and the case runs.
 */
const capabilityBody =
  <TStore>(
    check: CapabilityCheck<TStore>,
    isDeclared: boolean,
    body: ContractCaseBody<TStore>,
    context: TestContext,
  ): ContractCaseBody<TStore> =>
  async (instances) => {
    const present = [instances.first, instances.second].map(check.isPresent);
    const name = capabilityName(check.capability);
    if (!isDeclared) {
      expect(
        present,
        `[store-conformance.capability-not-declared] the store has ${check.capability} but does not declare it: give its entry capabilities: [${name}]`,
      ).toEqual([false, false]);
      context.skip(`the store does not declare ${name} (optional): ${check.without}`);
    }
    expect(
      present,
      `[store-conformance.capability-missing] the store declares ${name} but has no ${check.capability} on both instances' stores`,
    ).toEqual([true, true]);
    await body(instances);
  };

/**
 * The capabilities `target` declares, checked against `contract`'s (#831): a list of
 * `StoreCapability` values, each once, each one this contract's cases check — anything else would
 * be a claim no case reads, so the file fails before any case runs (`StoreConformanceError`).
 */
function checkCapabilities<TStore>(
  contract: string,
  target: ContractTarget<TStore>,
  groups: readonly ContractGroup<TStore>[],
): void {
  const declared: unknown = Reflect.get(target, "capabilities");
  if (declared === undefined) return;
  const known = new Set(
    groups.flatMap((group) => group.cases.flatMap((one) => one.capability?.capability ?? [])),
  );
  const problems: string[] = [];
  if (!Array.isArray(declared))
    problems.push(
      `[store-conformance.invalid-capabilities] ${contract} (${target.name}): capabilities is not a list of StoreCapability values`,
    );
  else {
    const seen = new Set<unknown>();
    for (const each of declared as unknown[]) {
      if (seen.has(each))
        problems.push(
          `[store-conformance.invalid-capabilities] ${contract} (${target.name}): ${String(each)} declared twice`,
        );
      seen.add(each);
      if (!isStoreCapability(each))
        problems.push(
          `[store-conformance.invalid-capabilities] ${contract} (${target.name}): ${typeof each === "string" ? JSON.stringify(each) : typeof each} is not a StoreCapability`,
        );
      else if (!known.has(each))
        problems.push(
          `[store-conformance.invalid-capabilities] ${contract} (${target.name}): ${capabilityName(each)} is not a capability of this contract${known.size === 0 ? " (it has none)" : `: ${[...known].map(capabilityName).join(", ")}`}`,
        );
    }
  }
  if (problems.length > 0) throw new StoreConformanceError({ problems });
}

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
    const { run, databaseTime, capability } = contractCase;
    if (!isGated && capability === undefined) {
      it(contractCase.name, withTarget(target, run, databaseTime));
      continue;
    }
    const isDeclared =
      capability !== undefined && (target.capabilities ?? []).includes(capability.capability);
    it(contractCase.name, (context) => {
      const checked =
        capability === undefined ? run : capabilityBody(capability, isDeclared, run, context);
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
  checkCapabilities(contract, target, groups);
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
