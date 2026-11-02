import { Application, EmptyEnvironment, Injectable } from "../../../src/index.js";
import {
  InMemoryExecutionHistoryRepository,
  type ExecutionHistoryRecord,
} from "../../../src/infrastructure/execution-history.repository.js";
import {
  InMemoryExecutionTreeRepository,
  type ExecutionTree,
} from "../../../src/infrastructure/execution-tree.repository.js";
import { RecordingLogger } from "../../helpers/log.js";
import { IN_MEMORY_DATABASE } from "../../../src/infrastructure/in-memory-database.js";
import { hours } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "./budgets.js";
import {
  DeskExecutionContext,
  DeskTenantContext,
  EvalDeskWorkflow,
  EvalEmailPiiPolicy,
} from "./eval-desk.fixture.js";
import { TreasuryWorkflow, treasuryChannels } from "./replies.fixture.js";
import { ContactPiiPolicy } from "../../pii/pii.fixture.js";
import { SensitiveWorkflow, ShopExecutionContext } from "../../pii/sensitive.fixture.js";

/**
 * #401 PR 1 — applications that keep their root executions' history (`executionRecordRetention`):
 * the refunds desk (#396's), the treasury (#267's), whose payouts pause for an approval, and the
 * shop whose execution's `userId` is marked `sensitive` (#120's).
 */

@Application({
  name: "history-desk-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [EvalDeskWorkflow],
  tenantContext: DeskTenantContext,
  executionContext: DeskExecutionContext,
  piiPolicies: [EvalEmailPiiPolicy],
  budgets: TEST_BUDGETS,
  executionRecordRetention: hours(24),
})
export class HistoryDeskApplication {}

@Application({
  name: "history-treasury-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [TreasuryWorkflow],
  budgets: TEST_BUDGETS,
  providers: treasuryChannels,
  executionRecordRetention: hours(24),
})
export class HistoryTreasuryApplication {}

@Application({
  name: "history-sensitive-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [SensitiveWorkflow],
  executionContext: ShopExecutionContext,
  piiPolicies: [ContactPiiPolicy],
  budgets: TEST_BUDGETS,
  executionRecordRetention: hours(24),
})
export class HistorySensitiveApplication {}

/** A history store that refuses every save (its database is down). */
@Injectable({ deps: [IN_MEMORY_DATABASE] })
export class RefusingExecutionHistoryRepository extends InMemoryExecutionHistoryRepository {
  override save(record: ExecutionHistoryRecord): Promise<void> {
    return Promise.reject(new Error(`the history store is down (${record.executionId})`));
  }
}

/** The refunds desk on a history store that is down, its log recorded. */
@Application({
  name: "broken-history-desk-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [EvalDeskWorkflow],
  tenantContext: DeskTenantContext,
  executionContext: DeskExecutionContext,
  providers: [RefusingExecutionHistoryRepository, RecordingLogger],
  budgets: TEST_BUDGETS,
  executionRecordRetention: hours(24),
})
export class BrokenHistoryDeskApplication {}

/** What the order fixtures below saw, in order (#699): each history save and each tree forgotten. */
export const endOrder: string[] = [];

/** A history store that notes each save in `endOrder`. */
@Injectable({ deps: [IN_MEMORY_DATABASE] })
export class NotingExecutionHistoryRepository extends InMemoryExecutionHistoryRepository {
  override save(record: ExecutionHistoryRecord): Promise<void> {
    endOrder.push(`history ${record.status}`);
    return super.save(record);
  }
}

/** A tree store that notes each tree forgotten in `endOrder` (the first step of a tree's cleanup). */
@Injectable({ deps: [IN_MEMORY_DATABASE] })
export class NotingExecutionTreeRepository extends InMemoryExecutionTreeRepository {
  override deleteAllInTree(tree: ExecutionTree): Promise<void> {
    endOrder.push("forgotten");
    return super.deleteAllInTree(tree);
  }
}

/** The refunds desk whose history and tree stores note the order of a tree's end (#699). */
@Application({
  name: "end-order-desk-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [EvalDeskWorkflow],
  tenantContext: DeskTenantContext,
  executionContext: DeskExecutionContext,
  providers: [NotingExecutionHistoryRepository, NotingExecutionTreeRepository],
  budgets: TEST_BUDGETS,
  executionRecordRetention: hours(24),
})
export class EndOrderDeskApplication {}
