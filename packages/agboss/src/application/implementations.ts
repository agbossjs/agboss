import { MemorySaver } from "@langchain/langgraph";
import type { Class, Provider } from "../components/injection.js";
import { tokenName } from "../components/injection.js";
import {
  INFRASTRUCTURE_DEFAULTS,
  infrastructureContractOf,
} from "../infrastructure/contracts.js";
import { InMemoryCostLedgerRepository } from "../infrastructure/cost-ledger.repository.js";
import { InMemoryPausedExecutionRepository } from "../infrastructure/paused-execution.repository.js";

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

/** The built-in in-memory classes: what is lost on restart and not shared by instances. */
const IN_MEMORY: readonly Class[] = [
  InMemoryCostLedgerRepository,
  InMemoryPausedExecutionRepository,
  MemorySaver,
];

/** Whether the contract's implementation keeps its data in this process's memory. */
export function isInMemory(choices: readonly ImplementationChoice[], contract: Class): boolean {
  const choice = choices.find((found) => found.contract === contract);
  if (choice === undefined) return false;
  const { implementation } = choice;
  return IN_MEMORY.some(
    (cls) =>
      implementation === cls ||
      Object.prototype.isPrototypeOf.call(cls.prototype, implementation.prototype),
  );
}
