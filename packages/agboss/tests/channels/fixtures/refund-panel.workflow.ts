import { Integer } from "../../../src/dto/index.js";
import {
  Agent,
  EmptyEnvironment,
  listOf,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Tracked,
  Action,
  inline,
  Ttl,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { RecordingLogger } from "../../helpers/log.js";
import { WaitTool } from "../../flow/fixtures/quorum-runtime-parts.js";
import {
  MortalExecutionLeaseRepository,
  RecoveryLog,
  StampedExecutionRecordRepository,
} from "../../infrastructure/fixtures/recovery.workflow.js";
import { seconds } from "../../../src/units/index.js";
import { onStart, toAction, toAgent } from "../../helpers/flow.js";
import {
  BatchSummaryDto,
  FinanceDeskRefundApprovalChannel,
  AutoRefundChannel,
  PauseLog,
  RefundRequestDto,
  RefundTool,
  SeenPausedExecutionRepository,
} from "./pauses.workflow.js";
import { TestModelProvider } from "../../../src/testing/test-model-provider.js";

/**
 * #337 — a refund decided by a panel: three agents score it, any two decide (a quorum); the risk
 * agent may first ask the finance desk to approve a test refund (a pause). When the other two
 * decide first, the risk agent's pause is withdrawn and the desk takes its question back. A second
 * panel decides by groups: the policy agent alone wins over the risk agent. A third, any one of
 * three within five minutes, runs where an instance may crash (#265).
 */

export class RefundScoreDto {
  @Integer({ prompt: "how sure the refund is right, 1–10" })
  score!: number;
}

@WorkflowStart({
  name: "refund-panel-workflow-start",
  description: "The order to refund",
  input: RefundRequestDto,
})
export class RefundPanelWorkflowStart {}

@Agent({
  name: "policy-agent",
  description: "Checks the refund policy",
  prompt: inline("Score the refund."),
  model: "moonshotai/kimi-k2.6",
  tools: [RefundTool],
  input: { request: RefundRequestDto },
  output: RefundScoreDto,
})
export class PolicyAgent {}

@Agent({
  name: "risk-agent",
  description: "Checks the refund's risk",
  prompt: inline("Score the refund."),
  model: "moonshotai/kimi-k2.6",
  tools: [RefundTool],
  input: { request: RefundRequestDto },
  output: RefundScoreDto,
})
export class RiskAgent {}

@Agent({
  name: "fraud-agent",
  description: "Checks the refund for fraud",
  prompt: inline("Score the refund."),
  model: "moonshotai/kimi-k2.6",
  tools: [RefundTool, WaitTool],
  input: { request: RefundRequestDto },
  output: RefundScoreDto,
})
export class FraudAgent {}

/** What a panel's finish reads: the counted scores. */
interface RefundScoresInput {
  readonly scores: readonly Tracked<RefundScoreDto>[];
}

const scoresOf = (input: RefundScoresInput): BatchSummaryDto => ({
  text: input.scores.map((score) => String(score.score))
    .join(", "),
});

@Action({
  name: "refund-decided-action",
  description: "The counted scores",
  input: { scores: listOf(RefundScoreDto) },
  output: BatchSummaryDto,
})
export class RefundDecidedAction {
  async execute(input: RefundScoresInput): Promise<BatchSummaryDto> {
    return scoresOf(input);
  }
}

@WorkflowFinish({
  name: "refund-decided-workflow-finish",
  description: "The counted scores",
  output: BatchSummaryDto,
})
export class RefundDecidedWorkflowFinish {}

@Action({
  name: "refund-escalated-action",
  description: "The risk agent's scores",
  input: { scores: listOf(RefundScoreDto) },
  output: BatchSummaryDto,
})
export class RefundEscalatedAction {
  async execute(input: RefundScoresInput): Promise<BatchSummaryDto> {
    return scoresOf(input);
  }
}

@WorkflowFinish({
  name: "refund-escalated-workflow-finish",
  description: "The risk agent's scores",
  output: BatchSummaryDto,
})
export class RefundEscalatedWorkflowFinish {}

@Workflow({
  name: "refund-panel-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(RefundPanelWorkflowStart)
      .inParallel([toAgent(PolicyAgent), toAgent(RiskAgent), toAgent(FraudAgent)])
      .joinQuorum({ min: 2 })
      .toAction(RefundDecidedAction)
      .toFinish(RefundDecidedWorkflowFinish),
  ],
})
export class RefundPanelWorkflow {}

@WorkflowStart({
  name: "refund-groups-workflow-start",
  description: "The order to refund",
  input: RefundRequestDto,
})
export class RefundGroupsWorkflowStart {}

@Workflow({
  name: "refund-groups-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(RefundGroupsWorkflowStart)
      .inParallel([toAgent(PolicyAgent), toAgent(RiskAgent)])
      .joinQuorumGroups()
      .onGroup(
        [PolicyAgent],
        { priority: 1 },
        toAction(RefundDecidedAction)
          .toFinish(RefundDecidedWorkflowFinish),
      )
      .onGroup(
        [RiskAgent],
        { priority: 2 },
        toAction(RefundEscalatedAction)
          .toFinish(RefundEscalatedWorkflowFinish),
      ),
  ],
})
export class RefundGroupsWorkflow {}

@Application({
  name: "refund-panel-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [RefundPanelWorkflow, RefundGroupsWorkflow],
  providers: [FinanceDeskRefundApprovalChannel, SeenPausedExecutionRepository, RecordingLogger],
  observers: [PauseLog],
  budgets: TEST_BUDGETS,
})
export class RefundPanelApplication {}

@WorkflowStart({
  name: "refund-recovery-workflow-start",
  description: "The order to refund",
  input: RefundRequestDto,
})
export class RefundRecoveryWorkflowStart {}

@Workflow({
  name: "refund-recovery-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(RefundRecoveryWorkflowStart)
      .inParallel([toAgent(PolicyAgent), toAgent(RiskAgent), toAgent(FraudAgent)])
      .joinQuorum({ min: 1, max: 3, deadline: seconds(300) })
      .toAction(RefundDecidedAction)
      .toFinish(RefundDecidedWorkflowFinish),
  ],
})
export class RefundRecoveryWorkflow {}

@Application({
  name: "refund-recovery-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [RefundRecoveryWorkflow],
  providers: [
    FinanceDeskRefundApprovalChannel,
    AutoRefundChannel,
    SeenPausedExecutionRepository,
    MortalExecutionLeaseRepository,
    StampedExecutionRecordRepository,
  ],
  observers: [RecoveryLog, PauseLog],
  budgets: TEST_BUDGETS,
})
export class RefundRecoveryApplication {}
