import { MemorySaver } from "@langchain/langgraph";
import type { Class, Provider } from "../components/injection.js";
import { tokenName } from "../components/injection.js";
import {
  INFRASTRUCTURE_DEFAULTS,
  InMemoryCheckpointSaver,
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

/**
 * The built-in in-memory classes (and LangGraph's `MemorySaver` listed as it is): lost on restart,
 * not shared by instances. A project's own subclass is its own choice and is not flagged.
 */
const IN_MEMORY: readonly Class[] = [
  InMemoryCostLedgerRepository,
  InMemoryPausedExecutionRepository,
  InMemoryCheckpointSaver,
  MemorySaver,
];

/** Whether the contract's implementation is a built-in one that keeps its data in memory. */
export function isInMemory(choices: readonly ImplementationChoice[], contract: Class): boolean {
  const choice = choices.find((found) => found.contract === contract);
  return choice !== undefined && IN_MEMORY.includes(choice.implementation);
}
