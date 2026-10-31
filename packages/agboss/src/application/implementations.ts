import { MemorySaver } from "@langchain/langgraph";
import type { Class, Provider } from "../components/injection.js";
import { tokenName } from "../components/injection.js";
import { violation, type RuleViolation } from "../graph/rule-error.js";
import {
  ExecutionLeaseRepository,
  InMemoryExecutionLeaseRepository,
  LeaseCheck,
} from "../infrastructure/execution-lease.repository.js";
import {
  INFRASTRUCTURE_DEFAULTS,
  InMemoryCheckpointSaver,
  infrastructureContractOf,
} from "../infrastructure/contracts.js";
import { InMemoryCostLedgerRepository } from "../infrastructure/cost-ledger.repository.js";
import { InMemoryPausedExecutionRepository } from "../infrastructure/paused-execution.repository.js";
import { InMemoryExecutionHistoryRepository } from "../infrastructure/execution-history.repository.js";
import { InMemoryChildExecutionQueueRepository } from "../infrastructure/child-execution-queue.repository.js";
import { FencedEffectRepository } from "../infrastructure/fenced-effect.repository.js";
import { OutboundCallRepository } from "../infrastructure/outbound-call.repository.js";

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
 * The contracts whose stores check the lease in their own transaction (#526), as a message calls
 * their stores: each listed one must be on the application's lease store's backend.
 */
export const FENCING_CONTRACTS: readonly FencingContract[] = [
  [FencedEffectRepository, "a fenced-effect store"],
  [OutboundCallRepository, "an outbound-call store"],
];

/** Whether `cls` is `base` or extends it. */
const isOrExtends = (cls: Class, base: Class): boolean =>
  cls === base || Object.prototype.isPrototypeOf.call(base.prototype, cls.prototype);

/** The declared backend of a store class (#526): its non-empty `static backend`, else none. */
export const backendOf = (cls: Class): string | undefined => {
  const backend: unknown = Reflect.get(cls, "backend");
  return typeof backend === "string" && backend !== "" ? backend : undefined;
};

/** A fencing contract and what a message calls one of its stores (`"a fenced-effect store"`). */
export type FencingContract = readonly [contract: Class, kind: string];

/** The listed store of `contract`, unless it opts out of the atomic lease check (#526). */
const checkedStoreOf = (classes: readonly Class[], contract: Class): Class | undefined => {
  const store = classes.find((cls) => isOrExtends(cls, contract));
  const isOptedOut =
    store !== undefined &&
    Reflect.get(store, "leaseCheck") === LeaseCheck.WithoutDoubleChargeProtection;
  return isOptedOut ? undefined : store;
};

/** How a class declares the backend it is on. */
const HOW = 'static backend = "postgres"';

/**
 * One transactional backend (#526): a listed fenced-effect or outbound-call store checks the lease
 * in its own transaction, so it and the application's lease store — listed, else the in-memory
 * default — declare one `backend`. Undeclared on either side, or two backends: a violation naming
 * the classes. A store with `LeaseCheck.WithoutDoubleChargeProtection` is not checked (the start
 * warns); an unlisted default is checked at its first call (`FencedEffectStoreMismatchError`).
 */
export function storeBackendViolations(
  application: string,
  providers: readonly Provider[],
  [contract, kind]: FencingContract,
): RuleViolation[] {
  const classes = listedClasses(providers);
  const store = checkedStoreOf(classes, contract);
  if (store === undefined) return [];
  const leases =
    classes.find((cls) => isOrExtends(cls, ExecutionLeaseRepository)) ??
    InMemoryExecutionLeaseRepository;
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
        `${store.name} (backend "${own}") checks its leases in its own transaction, but the application's leases are in ${leases.name} (backend "${theirs}"): a lease taken over meanwhile would not stop its write — list the stores of one backend together (SqliteFencedEffectRepository or SqliteOutboundCallRepository with SqliteExecutionLeaseRepository)`,
        [application],
      ),
    );
  return found;
}

/** The listed fencing stores that opt out of the atomic lease check (#526): the start warns. */
export const notAtomicStoresOf = (
  providers: readonly Provider[],
  contracts: readonly FencingContract[],
): readonly Class[] =>
  listedClasses(providers).filter(
    (cls) =>
      contracts.some(([contract]) => isOrExtends(cls, contract)) &&
      Reflect.get(cls, "leaseCheck") === LeaseCheck.WithoutDoubleChargeProtection,
  );
