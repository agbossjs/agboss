import { BaseCheckpointSaver, MemorySaver } from "@langchain/langgraph";
import { Injectable } from "../components/decorators.js";
import type { Class } from "../components/injection.js";
import { CostLedgerRepository, InMemoryCostLedgerRepository } from "./cost-ledger.repository.js";
import {
  ExecutionRecordRepository,
  InMemoryExecutionRecordRepository,
} from "./execution-record.repository.js";
import {
  InMemoryPausedExecutionRepository,
  PausedExecutionRepository,
} from "./paused-execution.repository.js";

/**
 * The infrastructure an application consumes (#261, S28): a framework contract with a built-in
 * default, one per application. Registered only in `@Application({ providers })`; the
 * implementation is found by inheritance — none listed → the default, two → ambiguous.
 */

/** The default checkpointer: LangGraph's `MemorySaver` — a pause is lost on restart. */
@Injectable()
export class InMemoryCheckpointSaver extends MemorySaver {}

/** Each contract with its built-in default (in memory: nothing is written to disk). */
export const INFRASTRUCTURE_DEFAULTS: ReadonlyMap<Class, Class> = new Map<Class, Class>([
  [BaseCheckpointSaver, InMemoryCheckpointSaver],
  [ExecutionRecordRepository, InMemoryExecutionRecordRepository],
  [CostLedgerRepository, InMemoryCostLedgerRepository],
  [PausedExecutionRepository, InMemoryPausedExecutionRepository],
]);

/** Whether `cls` is `contract` or extends it. */
const extendsContract = (cls: Class, contract: Class): boolean =>
  cls === contract || Object.prototype.isPrototypeOf.call(contract.prototype, cls.prototype);

/** The infrastructure contract a class implements, if any. */
export const infrastructureContractOf = (cls: Class): Class | undefined =>
  [...INFRASTRUCTURE_DEFAULTS.keys()].find((contract) => extendsContract(cls, contract));

/** What an application instance runs on: one instance per contract. */
export interface Infrastructure {
  readonly checkpointer: BaseCheckpointSaver;
  readonly records: ExecutionRecordRepository;
  readonly costLedger: CostLedgerRepository;
  readonly pausedExecutions: PausedExecutionRepository;
}

/** The infrastructure from the application's container (a listed class, else the default). */
export const infrastructureOf = (resolve: (contract: Class) => unknown): Infrastructure => ({
  // each contract resolves to an instance of a class that extends it (registrations by inheritance)
  checkpointer: resolve(BaseCheckpointSaver) as BaseCheckpointSaver,
  records: resolve(ExecutionRecordRepository) as ExecutionRecordRepository,
  costLedger: resolve(CostLedgerRepository) as CostLedgerRepository,
  pausedExecutions: resolve(PausedExecutionRepository) as PausedExecutionRepository,
});
