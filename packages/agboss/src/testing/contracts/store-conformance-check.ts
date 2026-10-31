/**
 * What `storeConformance` (#526) refuses before it registers anything: a store set whose fencing
 * contracts do not hold together — a lease store whose fenced-effect, outbound-call or lease-log
 * store is missing (its lease cases would never run: a double charge or a second owner nobody
 * tests), a fencing store without the lease store it checks, a contract both given and left out,
 * or no store at all. One error lists every problem.
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

/** Throws `StoreConformanceError` for a set whose fencing contracts do not hold together. */
export function checkStoreSet(set: ClaimedSet): void {
  const problems =
    set.claimed.length === 0
      ? [
          `[store-conformance.empty] "${set.name}" gives no store: list at least one in stores (executionLease, fencedEffect, …)`,
        ]
      : [...withoutProblemsOf(set), ...missingOf(set)];
  if (problems.length > 0) throw new StoreConformanceError(problems);
}
