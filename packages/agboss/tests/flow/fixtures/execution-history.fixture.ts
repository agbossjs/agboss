import { Application, EmptyEnvironment } from "../../../src/index.js";
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
