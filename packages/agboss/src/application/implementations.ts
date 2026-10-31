import { MemorySaver } from "@langchain/langgraph";
import type { Class, Provider } from "../components/injection.js";
import { tokenName } from "../components/injection.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import {
  ExecutionLeaseRepository,
  InMemoryExecutionLeaseRepository,
  LeaseCheck,
} from "../infrastructure/execution-lease.repository.js";
import { FencedEffectRepository } from "../infrastructure/fenced-effect.repository.js";
import { OutboundCallRepository } from "../infrastructure/outbound-call.repository.js";
import {
  INFRASTRUCTURE_DEFAULTS,
  InMemoryCheckpointSaver,
  infrastructureContractOf,
} from "../infrastructure/contracts.js";
import { InMemoryCostLedgerRepository } from "../infrastructure/cost-ledger.repository.js";
import { InMemoryPausedExecutionRepository } from "../infrastructure/paused-execution.repository.js";
import { InMemoryExecutionHistoryRepository } from "../infrastructure/execution-history.repository.js";
import { InMemoryChildExecutionQueueRepository } from "../infrastructure/child-execution-queue.repository.js";

/**
 * Which implementation of each infrastructure contract an application runs on, and why (#261):
 * the one class `@Application({ providers })` lists that `extends` the contract, else the built-in
 * default. Read from the declaration only — nothing is created — for `agboss describe` and the
 * assembly warnings.
 */

/** Why an implementation is the one used. */
export enum ImplementationReason {
  /** Listed in `@Application({ providers })`. */
  Listed = "listed",
  /** None listed: the built-in default. */
  Default = "default",
}

/** One contract and the class that implements it. */
export interface ImplementationChoice {
  readonly contract: Class;
  readonly implementation: Class;
  readonly reason: ImplementationReason;
}

/** The classes among the listed providers (values bound with `provide(…)` are not implementations). */
const listedClasses = (providers: readonly Provider[]): readonly Class[] =>
  providers.flatMap((provider) => (typeof provider === "function" ? [provider] : []));

/** Each contract with its implementation, in the order of the built-in defaults. */
export function implementationsOf(providers: readonly Provider[]): readonly ImplementationChoice[] {
  const listed = listedClasses(providers);
  return [...INFRASTRUCTURE_DEFAULTS].map(([contract, fallback]) => {
    const found = listed.find((cls) => infrastructureContractOf(cls) === contract);
    return found === undefined
      ? { contract, implementation: fallback, reason: ImplementationReason.Default }
      : { contract, implementation: found, reason: ImplementationReason.Listed };
  });
}

/** `CostLedgerRepository → SqliteCostLedgerRepository (listed in @Application providers)`. */
export const implementationLine = (choice: ImplementationChoice): string =>
  `${tokenName(choice.contract)} → ${tokenName(choice.implementation)} (${
    choice.reason === ImplementationReason.Listed
      ? "listed in @Application providers"
      : "built-in default: none listed"
  })`;

/**
 * The built-in in-memory classes (and LangGraph's `MemorySaver` listed as it is): lost on restart,
 * not shared by instances. A project's own subclass is its own choice and is not flagged.
 */
const IN_MEMORY: readonly Class[] = [
  InMemoryCostLedgerRepository,
  InMemoryPausedExecutionRepository,
  InMemoryCheckpointSaver,
  MemorySaver,
  InMemoryExecutionHistoryRepository,
  InMemoryChildExecutionQueueRepository,
];

/** Whether the contract's implementation is a built-in one that keeps its data in memory. */
export function isInMemory(choices: readonly ImplementationChoice[], contract: Class): boolean {
  const choice = choices.find((found) => found.contract === contract);
  return choice !== undefined && IN_MEMORY.includes(choice.implementation);
}

/**
 * One transactional backend (#526), checked at assembly from the declarations only: a listed
 * fenced-effect or outbound-call store checks the lease in its own transaction, so it and the
 * application's lease store declare one `static backend`; its violations name the classes, the
 * backends and a fix on the fencing store's own backend (#539); two listed stores of one fencing
 * contract, or of the lease contract, are named too (#539) — and every violation is reported at once.
 */

/** A fencing contract, what a message calls one of its stores, and its store of each core backend. */
interface FencingContract {
  readonly contract: Class;
  readonly kind: string;
  /** The core's store of this contract on each built-in backend, by name (none is loaded here). */
  readonly coreStores: Readonly<Record<string, string>>;
}

/** The contracts whose stores check the lease in their own transaction (#526). */
const FENCING_CONTRACTS: readonly FencingContract[] = [
  {
    contract: FencedEffectRepository,
    kind: "a fenced-effect store",
    coreStores: {
      "in-memory": "InMemoryFencedEffectRepository",
      sqlite: "SqliteFencedEffectRepository",
    },
  },
  {
    contract: OutboundCallRepository,
    kind: "an outbound-call store",
    coreStores: {
      "in-memory": "InMemoryOutboundCallRepository",
      sqlite: "SqliteOutboundCallRepository",
    },
  },
];

/** The core's lease store on each built-in backend, by name (#539: the hint of a mismatch). */
const CORE_LEASE_STORES: Readonly<Record<string, string>> = {
  "in-memory": "InMemoryExecutionLeaseRepository",
  sqlite: "SqliteExecutionLeaseRepository",
};

/** How a class declares the backend it is on. */
const HOW = 'static backend = "postgres"';

/** Whether `cls` is `base` or extends it. */
const isOrExtends = (cls: Class, base: Class): boolean =>
  cls === base || Object.prototype.isPrototypeOf.call(base.prototype, cls.prototype);

/** The classes among the listed providers, each once (values bound with `provide(…)` are not stores). */
const uniqueClasses = (providers: readonly Provider[]): readonly Class[] => [
  ...new Set(providers.flatMap((provider) => (typeof provider === "function" ? [provider] : []))),
];

/** The declared backend of a store class (#526): its non-empty `static backend`, else none. */
export const backendOf = (cls: Class): string | undefined => {
  const backend: unknown = Reflect.get(cls, "backend");
  return typeof backend === "string" && backend !== "" ? backend : undefined;
};

const isOptedOut = (store: Class): boolean =>
  Reflect.get(store, "leaseCheck") === LeaseCheck.WithoutDoubleChargeProtection;

/** `a lease store declaring backend "sqlite" (SqliteExecutionLeaseRepository)`: one to list. */
const storeOn = (
  what: string,
  backend: string,
  known: Readonly<Record<string, string>>,
): string => {
  const core = known[backend];
  return `${what} declaring backend "${backend}"${core === undefined ? "" : ` (${core})`}`;
};

/** Two or more listed stores of one contract (#539): the application has to list one. */
function ambiguityOf(application: string, stores: readonly Class[], what: string): RuleViolation[] {
  if (stores.length < 2) return [];
  const names = stores.map((cls) => `${cls.name}${describedBackend(cls)}`).join(", ");
  return [
    violation(
      "di.ambiguous-implementation",
      `${String(stores.length)} listed classes are ${what}: ${names} — list one`,
      [application],
    ),
  ];
}

const describedBackend = (cls: Class): string => {
  const backend = backendOf(cls);
  return backend === undefined ? " (no backend)" : ` (backend "${backend}")`;
};

/** The violations of one fencing store beside the application's lease store. */
function pairViolations(
  application: string,
  store: Class,
  leases: Class,
  { kind, coreStores }: FencingContract,
): RuleViolation[] {
  const [own, theirs] = [backendOf(store), backendOf(leases)];
  const found: RuleViolation[] = [];
  const undeclared = (message: string) =>
    found.push(violation("application.store-backend-undeclared", message, [application]));
  if (own === undefined)
    undeclared(
      `${store.name} declares no backend: ${kind} checks its leases in its own transaction, so it and its lease store declare the database they are in (${HOW}) and assembly checks it is one — or it opts out with static leaseCheck = LeaseCheck.WithoutDoubleChargeProtection, losing that protection`,
    );
  if (theirs === undefined)
    undeclared(
      `${leases.name} declares no backend: ${store.name}, ${kind}, checks the application's leases in its own transaction, so the lease store declares the database it is in (${HOW})`,
    );
  if (own !== undefined && theirs !== undefined && own !== theirs)
    found.push(
      violation(
        "application.store-backend-mismatch",
        `${store.name} (backend "${own}") checks its leases in its own transaction, but the application's leases are in ${leases.name} (backend "${theirs}"): a lease taken over meanwhile would not stop its write — list it with ${storeOn("a lease store", own, CORE_LEASE_STORES)}, or list ${storeOn(kind, theirs, coreStores)} in its place`,
        [application],
      ),
    );
  return found;
}

/**
 * Every violation of one transactional backend (#526, #539) in `providers`: two listed lease
 * stores, two listed stores of a fencing contract, and each listed fencing store — unless it opts
 * out with `LeaseCheck.WithoutDoubleChargeProtection` (the start warns) — beside the application's
 * lease store (listed, else the in-memory default). An unlisted default fencing store is checked at
 * its first call (`FencedEffectStoreMismatchError`).
 */
export function storeBackendViolations(
  application: string,
  providers: readonly Provider[],
): RuleViolation[] {
  const classes = uniqueClasses(providers);
  const leaseStores = classes.filter((cls) => isOrExtends(cls, ExecutionLeaseRepository));
  const found = ambiguityOf(application, leaseStores, "lease stores (ExecutionLeaseRepository)");
  // with two lease stores the pairing is unknown: their ambiguity is the one problem to fix first
  const leases =
    leaseStores.length > 1 ? undefined : (leaseStores[0] ?? InMemoryExecutionLeaseRepository);
  for (const fencing of FENCING_CONTRACTS) {
    const stores = classes.filter((cls) => isOrExtends(cls, fencing.contract));
    const what = `${fencing.kind.replace(/^an? /u, "")}s (${fencing.contract.name})`;
    found.push(...ambiguityOf(application, stores, what));
    if (leases === undefined) continue;
    for (const store of stores.filter((cls) => !isOptedOut(cls)))
      found.push(...pairViolations(application, store, leases, fencing));
  }
  return found;
}

/** The listed fencing stores that opt out of the atomic lease check (#526): the start warns. */
export const notAtomicStoresOf = (providers: readonly Provider[]): readonly Class[] =>
  uniqueClasses(providers).filter(
    (cls) =>
      FENCING_CONTRACTS.some(({ contract }) => isOrExtends(cls, contract)) && isOptedOut(cls),
  );
