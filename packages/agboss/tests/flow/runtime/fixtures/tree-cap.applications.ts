import { EmptyEnvironment } from "../../../../src/index.js";
import { Application } from "../../../../src/application/application.js";
import {
  MortalExecutionLeaseRepository,
  RecoveryLog,
  StampedExecutionRecordRepository,
} from "../../../infrastructure/fixtures/recovery.workflow.js";
import { TEST_BUDGETS } from "../../fixtures/budgets.js";
import { BatchWorkflow, SerialBatchWorkflow, SingleFileWorkflow } from "./tree-batch.workflow.js";
import { ChecksWorkflow } from "./tree-checks.workflow.js";
import { GroupsWorkflow, NarrowGroupsWorkflow } from "./tree-groups.workflow.js";
import { VotingWorkflow } from "./tree-vote.workflow.js";
import { StrictVotingWorkflow } from "./tree-strict-vote.workflow.js";

/** #264 PR 2 — the applications of the tree's concurrency cap. */

@Application({
  name: "tree-cap-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [
    BatchWorkflow,
    SerialBatchWorkflow,
    SingleFileWorkflow,
    GroupsWorkflow,
    NarrowGroupsWorkflow,
    ChecksWorkflow,
    VotingWorkflow,
    StrictVotingWorkflow,
  ],
  budgets: TEST_BUDGETS,
})
export class TreeCapApplication {}

/** The single-file tree on two instances that share their stores: a crash, a recovery. */
@Application({
  name: "tree-cap-recovery-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [SingleFileWorkflow],
  observers: [RecoveryLog],
  providers: [MortalExecutionLeaseRepository, StampedExecutionRecordRepository],
  budgets: TEST_BUDGETS,
})
export class TreeCapRecoveryApplication {}
