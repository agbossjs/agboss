import { Integer } from "../../../src/dto/index.js";
import {
  Agent,
  EmptyEnvironment,
  listOf,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Produced,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { groupFrom } from "../../../src/flow/path-builder.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { RecordingLogger } from "../../helpers/log.js";
import { WaitTool } from "../../flow/fixtures/quorum-runtime-parts.js";
import {
  MortalExecutionLeaseRepository,
  RecoveryLog,
  StampedExecutionRecordRepository,
} from "../../infrastructure/fixtures/recovery.workflow.js";
import { seconds } from "../../../src/units/index.js";
import { start } from "../../helpers/flow.js";
import {
  BatchSummaryDto,
  FinanceDeskRefundApprovalChannel,
  PauseLog,
  RefundRequestDto,
  RefundTool,
  SeenPausedExecutionRepository,
} from "./pauses.workflow.js";

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
  prompt: "Score the refund.",
  model: "moonshotai/kimi-k2.6",
  tools: [RefundTool],
  input: { request: RefundRequestDto },
  output: RefundScoreDto,
})
export class PolicyAgent {}

@Agent({
  name: "risk-agent",
  description: "Checks the refund's risk",
  prompt: "Score the refund.",
  model: "moonshotai/kimi-k2.6",
  tools: [RefundTool],
  input: { request: RefundRequestDto },
  output: RefundScoreDto,
})
export class RiskAgent {}

@Agent({
  name: "fraud-agent",
  description: "Checks the refund for fraud",
  prompt: "Score the refund.",
  model: "moonshotai/kimi-k2.6",
  tools: [RefundTool, WaitTool],
  input: { request: RefundRequestDto },
  output: RefundScoreDto,
})
export class FraudAgent {}

/** What a panel's finish reads: the counted scores. */
interface RefundScoresInput {
  readonly scores: readonly Produced<RefundScoreDto, unknown>[];
}

const scoresOf = (input: RefundScoresInput): BatchSummaryDto => ({
  text: input.scores
    .map((score) => String(score.value.score))
    .join(", "),
});

@WorkflowFinish({
  name: "refund-decided-workflow-finish",
  description: "The counted scores",
  input: { scores: listOf(RefundScoreDto) },
  output: BatchSummaryDto,
})
export class RefundDecidedWorkflowFinish {
  finish(input: RefundScoresInput): BatchSummaryDto {
    return scoresOf(input);
  }
}

@WorkflowFinish({
  name: "refund-escalated-workflow-finish",
  description: "The risk agent's scores",
  input: { scores: listOf(RefundScoreDto) },
  output: BatchSummaryDto,
})
export class RefundEscalatedWorkflowFinish {
  finish(input: RefundScoresInput): BatchSummaryDto {
    return scoresOf(input);
  }
}

@Workflow({
  name: "refund-panel-workflow",
  version: "1.0.0",
  flow: [
    start(RefundPanelWorkflowStart)
      .returns(RefundRequestDto)
      .toParallelAgents(PolicyAgent, RiskAgent, FraudAgent)
      .joinQuorum({ min: 2 })
      .returns(listOf(RefundScoreDto))
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
  flow: [
    start(RefundGroupsWorkflowStart)
      .returns(RefundRequestDto)
      .toParallelAgents(PolicyAgent, RiskAgent)
      .joinQuorumGroups(
        groupFrom([PolicyAgent])
          .priority(1)
          .returns(listOf(RefundScoreDto))
          .toFinish(RefundDecidedWorkflowFinish),
        groupFrom([RiskAgent])
          .priority(2)
          .returns(listOf(RefundScoreDto))
          .toFinish(RefundEscalatedWorkflowFinish),
      ),
  ],
})
export class RefundGroupsWorkflow {}

@Application({
  name: "refund-panel-application",
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
  flow: [
    start(RefundRecoveryWorkflowStart)
      .returns(RefundRequestDto)
      .toParallelAgents(PolicyAgent, RiskAgent, FraudAgent)
      .joinQuorum({ min: 1, max: 3, deadline: seconds(300) })
      .returns(listOf(RefundScoreDto))
      .toFinish(RefundDecidedWorkflowFinish),
  ],
})
export class RefundRecoveryWorkflow {}

@Application({
  name: "refund-recovery-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [RefundRecoveryWorkflow],
  providers: [
    FinanceDeskRefundApprovalChannel,
    SeenPausedExecutionRepository,
    MortalExecutionLeaseRepository,
    StampedExecutionRecordRepository,
  ],
  observers: [RecoveryLog, PauseLog],
  budgets: TEST_BUDGETS,
})
export class RefundRecoveryApplication {}
