import {
  ApplicationContext,
  PauseListener,
  SqliteCheckpointSaver,
  SqliteCostLedgerRepository,
  SqliteExecutionRecordRepository,
  SqliteExecutionTreeRepository,
  SqlitePausedExecutionRepository,
  SqliteRateLimitRepository,
  type PauseListenerClosedEvent,
  type PauseListenerHandler,
  type PauseListenerOpenedEvent,
} from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import { TEST_BUDGETS } from "../../../flow/fixtures/budgets.js";
import { RecoveryWorkflow } from "../../fixtures/recovery.workflow.js";
import { SqliteTestEnvironment } from "./environments/app.environment.js";
import { MortalSqliteExecutionLeaseRepository } from "./sqlite.workflow.js";

/**
 * #940 — the recovery fixture's workflow in an application on the SQLite file with a pause listener:
 * what each instance's listener was told, and a gate that holds its hook.
 */

/** One delivery the listener of an instance was made. */
export interface Delivery {
  readonly instance: string;
  readonly notice: "opened" | "closed";
  readonly deliveryId: string;
}

export const deliveries: Delivery[] = [];
export const gate: { active: number; widest: number; hold?: Promise<void> } = {
  active: 0,
  widest: 0,
};

@PauseListener({ name: "crash-pause-listener", deps: [ApplicationContext] })
class CrashPauseListener implements PauseListenerHandler {
  constructor(private readonly context: ApplicationContext) {}

  async onPauseOpened(event: PauseListenerOpenedEvent): Promise<void> {
    await this.#heard("opened", event.deliveryId);
  }

  async onPauseClosed(event: PauseListenerClosedEvent): Promise<void> {
    await this.#heard("closed", event.deliveryId);
  }

  async #heard(notice: "opened" | "closed", deliveryId: string): Promise<void> {
    gate.active += 1;
    gate.widest = Math.max(gate.widest, gate.active);
    deliveries.push({ instance: this.context.instanceId, notice, deliveryId });
    try {
      await gate.hold;
    } finally {
      gate.active -= 1;
    }
  }
}

@Application({
  name: "sqlite-notices-application",
  version: "1.0.0",
  environment: SqliteTestEnvironment,
  workflows: [RecoveryWorkflow],
  providers: [
    MortalSqliteExecutionLeaseRepository,
    SqliteExecutionRecordRepository,
    SqlitePausedExecutionRepository,
    SqliteCheckpointSaver,
    SqliteCostLedgerRepository,
    SqliteExecutionTreeRepository,
    SqliteRateLimitRepository,
    CrashPauseListener,
  ],
  budgets: TEST_BUDGETS,
})
export class SqliteNoticesApplication {}
