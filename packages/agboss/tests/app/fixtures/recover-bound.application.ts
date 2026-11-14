import { EmptyEnvironment, Injectable } from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { Clock, IdGenerator } from "../../../src/infrastructure/clock.js";
import {
  ExecutionRecordRepository,
  InMemoryExecutionRecordRepository,
  type ExecutionRecordStatus,
} from "../../../src/infrastructure/execution-record.repository.js";
import { Logger, type LogEntry } from "../../../src/infrastructure/logger.js";
import type { Turn } from "../../../src/turns/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { ClaimRoomBatchWorkflow, ClaimRoomItemWorkflow } from "./claim-room.workflow.js";

/**
 * #928 recoverApp — a record store the next app of the same test reuses (`reusableInfrastructure`),
 * whose look at the running executions can be held for ever; a logger per instance; a probe that
 * keeps what each instance's container resolved: its (bounded) record store and its own log.
 */
export const held = { records: false };

/** What one application instance resolved. */
export interface Instance {
  readonly records: ExecutionRecordRepository;
  readonly entries: LogEntry[];
}

/** One per application instance built, in the order built: App 1, App 2. */
export const instances: Instance[] = [];
const logs: LogEntry[][] = [];

export const resetRecover = (): void => {
  held.records = false;
  instances.length = 0;
  logs.length = 0;
};

@Injectable({ deps: [Clock, IdGenerator] })
export class HoldableRecordRepository extends InMemoryExecutionRecordRepository {
  override findByStatus(
    status: ExecutionRecordStatus,
    limit: number,
    after?: string,
  ): Promise<Turn[]> {
    return held.records
      ? new Promise<Turn[]>(() => undefined)
      : super.findByStatus(status, limit, after);
  }
}

/** A log per instance: what each instance's `FrameworkLog` wrote. */
@Injectable()
export class InstanceLogger extends Logger {
  readonly entries: LogEntry[] = [];

  constructor() {
    super();
    logs.push(this.entries);
  }

  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

@Injectable({ deps: [ExecutionRecordRepository, Logger] })
export class InstanceProbe {
  constructor(records: ExecutionRecordRepository, log: Logger) {
    instances.push({ records, entries: log instanceof InstanceLogger ? log.entries : [] });
  }
}

@Application({
  name: "recover-bound-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ClaimRoomBatchWorkflow, ClaimRoomItemWorkflow],
  budgets: TEST_BUDGETS,
  providers: [HoldableRecordRepository, InstanceLogger, InstanceProbe],
})
export class RecoverBoundApplication {}
