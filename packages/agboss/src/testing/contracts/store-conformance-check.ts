/**
 * What `storeConformance` (#526) refuses before it registers anything: a store set whose fencing
 * contracts do not hold together — a lease store whose fenced-effect, outbound-call or lease-log
 * store is missing (its lease cases would never run: a double charge or a second owner nobody
 * tests), a fencing store without the lease store it checks, a contract both given and left out,
 * a store under a key that names no contract (#542: it would never be tested), no store at all, or
 * an interleaving budget that is no budget (#799: `walks: 0` would search nothing and pass). One
 * error lists every problem.
 */

/** The fencing contracts a set with a lease store may leave out, by its `stores` key. */
export type LeftOutContract = "executionLeaseEvent" | "fencedEffect" | "outboundCall";

/** What each one's cases prove, for the message that says it is missing. */
const PROVES: Readonly<Record<LeftOutContract, string>> = {
  fencedEffect: "its writes and the lease check in one transaction, a zombie's write refused",
  outboundCall: "its intents fenced by these leases, leaseStateOf's races with a late renewal",
  executionLeaseEvent: "every row the core writes to the lease log, read back as it was",
};

const LEFT_OUT: readonly LeftOutContract[] = [
  "fencedEffect",
  "outboundCall",
  "executionLeaseEvent",
];

/** The keys a set gives, as `storeConformance` reads them. */
export interface ClaimedSet {
  readonly name: string;
  readonly claimed: readonly string[];
  readonly without: readonly string[];
  /** The set's `interleavings`, as given (unchecked). */
  readonly interleavings?: unknown;
}

/**
 * A store set `storeConformance` refuses (#526): `code` is the first problem's, `problems` all of
 * them, each `[store-conformance.<rule>] …` — thrown while the suites are registered, so the file
 * fails before any case runs.
 */
export class StoreConformanceError extends Error {
  override name = "StoreConformanceError";
  readonly code: string;
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `storeConformance refuses the store set:\n${problems.map((line) => `  - ${line}`).join("\n")}`,
    );
    this.problems = problems;
    this.code = /^\[([^\]]+)\]/u.exec(problems[0] ?? "")?.[1] ?? "store-conformance";
  }
}

/** What the set leaves out by mistake: a fencing contract neither given nor listed in `without`. */
function missingOf(set: ClaimedSet): string[] {
  const has = (key: string): boolean => set.claimed.includes(key);
  const isFencing = has("executionLease") || has("fencedEffect") || has("outboundCall");
  if (!isFencing) return [];
  const problems: string[] = [];
  if (!has("executionLease"))
    problems.push(
      `[store-conformance.lease-store-required] "${set.name}" has a fenced-effect or outbound-call store but no stores.executionLease: they check its leases, so the lease contract runs on the same backend`,
    );
  for (const key of LEFT_OUT) {
    if (has(key) || set.without.includes(key)) continue;
    problems.push(
      `[store-conformance.missing-fencing-contract] "${set.name}" has fencing stores but no stores.${key}: its cases (${PROVES[key]}) would not run — give stores.${key}, or list "${key}" in without when the set has none (an application on these leases then lists none either)`,
    );
  }
  return problems;
}

/** What `without` says that cannot be: a contract given anyway, or one that may not be left out. */
function withoutProblemsOf(set: ClaimedSet): string[] {
  return set.without.flatMap((key) => {
    if (!(LEFT_OUT as readonly string[]).includes(key))
      return [
        `[store-conformance.invalid-without] "${set.name}" lists "${key}" in without: only ${LEFT_OUT.map((one) => `"${one}"`).join(", ")} may be left out`,
      ];
    if (set.claimed.includes(key))
      return [
        `[store-conformance.without-implemented] "${set.name}" gives stores.${key} and lists it in without: one or the other`,
      ];
    return [];
  });
}

/** A value as a message shows it: a number as written (NaN too), anything else as JSON. */
const valueText = (value: unknown): string =>
  typeof value === "number" ? String(value) : JSON.stringify(value);

const isCount = (value: unknown): boolean => Number.isSafeInteger(value) && (value as number) >= 1;

/** Each budget field: what it must be, and whether a value is that. */
const BUDGET_FIELDS: Readonly<Record<string, readonly [string, (value: unknown) => boolean]>> = {
  depth: ["a whole number of at least 1", isCount],
  walks: ["a whole number of at least 1", isCount],
  walkDepth: ["a whole number of at least 1", isCount],
  seed: ["a whole number", (value) => Number.isSafeInteger(value)],
  timeLimit: [
    "a positive number of ms",
    (value) => typeof value === "number" && Number.isFinite(value) && value > 0,
  ],
};

/** What a budget field holds that it may not: `undefined` when it is valid or absent. */
function budgetFieldProblem(key: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const field = Object.hasOwn(BUDGET_FIELDS, key) ? BUDGET_FIELDS[key] : undefined;
  if (field === undefined)
    return "no option of the explorer (depth, walks, walkDepth, seed, timeLimit)";
  const [must, isValid] = field;
  return isValid(value) ? undefined : must;
}

/**
 * What the set's `interleavings` says that is no budget (#799): anything but `false` or an
 * object, a count that is not a whole number of at least 1 (`walks: 0` searches nothing), a
 * seed that is not whole, a time limit that is not positive, a key the explorer has no option for.
 */
function interleavingProblemsOf(set: ClaimedSet): string[] {
  const given = set.interleavings;
  if (given === undefined || given === false) return [];
  const invalid = (what: string): string =>
    `[store-conformance.invalid-interleavings] "${set.name}" gives interleavings${what}: give a budget ({ depth, walks, walkDepth, seed, timeLimit }) or false`;
  if (typeof given !== "object" || given === null || Array.isArray(given))
    return [invalid(` = ${valueText(given)}`)];
  return Object.entries(given).flatMap(([key, value]) => {
    const problem = budgetFieldProblem(key, value);
    return problem === undefined
      ? []
      : [invalid(`.${key} = ${valueText(value)}, which must be ${problem}`)];
  });
}

/** Every key of `stores`, one per contract with a suite (`ConformanceStores`). */
export const CONTRACTS: readonly string[] = [
  "checkpointSaver",
  "childExecutionQueue",
  "costLedger",
  "executionHistory",
  "executionLease",
  "executionLeaseEvent",
  "executionRecord",
  "executionTree",
  "fencedEffect",
  "meshRequest",
  "outboundCall",
  "pausedExecution",
  "rateLimit",
];

/** A key of `stores` that names no contract (#542): its store would never be tested. */
const unknownOf = (set: ClaimedSet): string[] =>
  set.claimed
    .filter((key) => !CONTRACTS.includes(key))
    .map(
      (key) =>
        `[store-conformance.unknown-store] "${set.name}" gives stores.${key}, which names no contract: its store would never be tested — use one of ${CONTRACTS.join(", ")}`,
    );

/** Throws `StoreConformanceError` for a set whose fencing contracts do not hold together. */
export function checkStoreSet(set: ClaimedSet): void {
  const problems =
    set.claimed.length === 0
      ? [
          `[store-conformance.empty] "${set.name}" gives no store: list at least one in stores (executionLease, fencedEffect, …)`,
        ]
      : [
          ...unknownOf(set),
          ...withoutProblemsOf(set),
          ...missingOf(set),
          ...interleavingProblemsOf(set),
        ];
  if (problems.length > 0) throw new StoreConformanceError(problems);
}
