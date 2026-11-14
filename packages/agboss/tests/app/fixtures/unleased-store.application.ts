import { Injectable } from "../../../src/components/decorators.js";
import { Application } from "../../../src/application/application.js";
import { hours } from "../../../src/units/index.js";
import { InMemoryFencedEffectRepository } from "../../../src/index.js";
import { IN_MEMORY_DATABASE } from "../../../src/infrastructure/in-memory-database.js";
import {
  InMemoryExecutionHistoryRepository,
  type ExecutionHistoryRecord,
} from "../../../src/infrastructure/execution-history.repository.js";
import {
  InMemoryExecutionTreeRepository,
  type ExecutionTree,
} from "../../../src/infrastructure/execution-tree.repository.js";
import { IdempotencyKeyEnvironment } from "../../helpers/idempotency-key.environment.js";
import { RecordingLogger } from "../../helpers/log.js";
import { TestApplicationDailyBudget, TestTenantDailyBudget } from "../../flow/fixtures/budgets.js";
import { RecoveryLog } from "../../infrastructure/fixtures/recovery.workflow.js";
import {
  ChargeWorkflow,
  DoubleChargeWorkflow,
  FencedExecutionBudget,
} from "./fenced-effect.workflow.js";

/**
 * #928 AC1 — the post-terminal cleanup of a tree on stores that can go quiet: from the moment the
 * test sets a flag, the tree's key removal (`forgetTree`) and the kept record's save
 * (`keepExecutionRecord`) return a promise that never settles. Both run after the terminal record,
 * outside the lease scope: a bound that fires there is an ordinary store error, never a hand-over.
 */
export const quiet = { trees: false, history: false, treeCalls: 0, historyCalls: 0 };

export const resetQuiet = (): void => {
  quiet.trees = false;
  quiet.history = false;
  quiet.treeCalls = 0;
  quiet.historyCalls = 0;
};

@Injectable({ deps: [IN_MEMORY_DATABASE] })
export class QuietTrees extends InMemoryExecutionTreeRepository {
  override deleteAllInTree(tree: ExecutionTree): Promise<void> {
    if (!quiet.trees) return super.deleteAllInTree(tree);
    quiet.treeCalls += 1;
    return new Promise<void>(() => undefined);
  }
}

@Injectable({ deps: [IN_MEMORY_DATABASE] })
export class QuietHistory extends InMemoryExecutionHistoryRepository {
  override save(record: ExecutionHistoryRecord): Promise<void> {
    if (!quiet.history) return super.save(record);
    quiet.historyCalls += 1;
    return new Promise<void>(() => undefined);
  }
}

@Application({
  name: "unleased-store-application",
  version: "1.0.0",
  environment: IdempotencyKeyEnvironment,
  idempotencyKeyField: "idempotencyKey",
  workflows: [ChargeWorkflow, DoubleChargeWorkflow],
  observers: [RecoveryLog],
  budgets: [TestApplicationDailyBudget, TestTenantDailyBudget, FencedExecutionBudget],
  retention: { executionRecords: hours(24) },
  providers: [QuietTrees, QuietHistory, InMemoryFencedEffectRepository, RecordingLogger],
})
export class UnleasedStoreApplication {}
