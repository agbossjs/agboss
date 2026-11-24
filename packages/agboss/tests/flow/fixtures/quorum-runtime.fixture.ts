import { Application } from "../../../src/application/application.js";
import { anyOf } from "../../../src/flow/builder.js";
import { groupFrom } from "../../../src/flow/path-builder.js";
import {
  ArbiterError,
  EmptyEnvironment,
  QuorumNotReachedError,
  Workflow,
} from "../../../src/index.js";
import { seconds } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "./budgets.js";
import {
  MortalExecutionLeaseRepository,
  RecoveryLog,
  StampedExecutionRecordRepository,
} from "../../infrastructure/fixtures/recovery.workflow.js";
import { onStart, toFinish } from "../../helpers/flow.js";
import {
  CopyArbiter,
  CriticPanelAgent,
  DealPanelWorkflowStart,
  DealReportPanelAgent,
  DealReportPanelWorkflowFinish,
  EvenItemArbiter,
  FastPanelAgent,
  HirePanelAgent,
  InRangeArbiter,
  LegalPanelAgent,
  NoQuorumPanelWorkflowFinish,
  PanelFailedWorkflowFinish,
  PanelItemsWorkflowStart,
  PanelChatArbiter,
  PanelModelArbiter,
  PanelReviewWorkflowFinish,
  PanelSummaryAgent,
  PanelUnjudgedWorkflowFinish,
  PanelWorkflowStart,
  QuickRejectPanelWorkflowFinish,
  QuorumLog,
  RisksPanelAgent,
  SecondOpinionPanelWorkflowFinish,
  SkillsPanelAgent,
} from "./quorum-runtime-parts.js";

/**
 * #279 PR 2 — quorums at run time, one application per workflow: any two of three; a quorum with an
 * arbiter, `max` and a deadline; one without `.onError`; a model arbiter, a chain and `anyOf`;
 * a per-item and a copies launch with code arbiters reading `ExecutionContext`; groups with priority.
 */

const PANEL = [SkillsPanelAgent, RisksPanelAgent, HirePanelAgent] as const;

@Workflow({
  name: "quick-panel-workflow",
  version: "1.0.0",
  flow: [
    onStart(PanelWorkflowStart)
      .toParallelAgents(...PANEL)
      .joinQuorum({ min: 2 })
      .toAgent(PanelSummaryAgent)
      .toFinish(PanelReviewWorkflowFinish),
  ],
})
export class QuickPanelWorkflow {}

@Workflow({
  name: "checked-panel-workflow",
  version: "1.0.0",
  flow: [
    onStart(PanelWorkflowStart)
      .toParallelAgents(...PANEL)
      .acceptedBy(InRangeArbiter)
      .joinQuorum({ min: 2, max: 3, deadline: seconds(30) })
      .onError(QuorumNotReachedError, toFinish(PanelFailedWorkflowFinish))
      .onError(ArbiterError, toFinish(PanelUnjudgedWorkflowFinish))
      .toAgent(PanelSummaryAgent)
      .toFinish(PanelReviewWorkflowFinish),
  ],
})
export class CheckedPanelWorkflow {}

@Workflow({
  name: "strict-panel-workflow",
  version: "1.0.0",
  flow: [
    onStart(PanelWorkflowStart)
      .toParallelAgents(...PANEL)
      .acceptedBy(InRangeArbiter)
      .joinQuorum({ min: 2 })
      .toAgent(PanelSummaryAgent)
      .toFinish(PanelReviewWorkflowFinish),
  ],
})
export class StrictPanelWorkflow {}

@Workflow({
  name: "model-panel-workflow",
  version: "1.0.0",
  flow: [
    onStart(PanelWorkflowStart)
      .toParallelAgents(...PANEL)
      .acceptedBy(PanelModelArbiter)
      .joinQuorum({ min: 2, max: 3 })
      .onError(ArbiterError, toFinish(PanelUnjudgedWorkflowFinish))
      .toAgent(PanelSummaryAgent)
      .toFinish(PanelReviewWorkflowFinish),
  ],
})
export class ModelPanelWorkflow {}

@Workflow({
  name: "chat-panel-workflow",
  version: "1.0.0",
  flow: [
    onStart(PanelWorkflowStart)
      .toParallelAgents(...PANEL)
      .acceptedBy(PanelChatArbiter)
      .joinQuorum({ min: 2, max: 3 })
      .toAgent(PanelSummaryAgent)
      .toFinish(PanelReviewWorkflowFinish),
  ],
})
export class ChatPanelWorkflow {}

@Workflow({
  name: "chain-panel-workflow",
  version: "1.0.0",
  flow: [
    onStart(PanelWorkflowStart)
      .toParallelAgents(...PANEL)
      .acceptedBy(InRangeArbiter)
      .acceptedBy(PanelModelArbiter)
      .joinQuorum({ min: 1, max: 3 })
      .toAgent(PanelSummaryAgent)
      .toFinish(PanelReviewWorkflowFinish),
  ],
})
export class ChainPanelWorkflow {}

@Workflow({
  name: "any-of-panel-workflow",
  version: "1.0.0",
  flow: [
    onStart(PanelWorkflowStart)
      .toParallelAgents(...PANEL)
      .acceptedBy(anyOf(InRangeArbiter, PanelModelArbiter))
      .joinQuorum({ min: 1, max: 3 })
      .toAgent(PanelSummaryAgent)
      .toFinish(PanelReviewWorkflowFinish),
  ],
})
export class AnyOfPanelWorkflow {}

@Workflow({
  name: "item-panel-workflow",
  version: "1.0.0",
  maxSteps: 10,
  flow: [
    onStart(PanelItemsWorkflowStart)
      .toParallelAgents(SkillsPanelAgent, { maxItems: 5 })
      .acceptedBy(EvenItemArbiter)
      .joinQuorum({ min: 3 })
      .toAgent(PanelSummaryAgent)
      .toFinish(PanelReviewWorkflowFinish),
  ],
})
export class ItemPanelWorkflow {}

@Workflow({
  name: "copies-panel-workflow",
  version: "1.0.0",
  flow: [
    onStart(PanelWorkflowStart)
      .toParallelAgents(SkillsPanelAgent, SkillsPanelAgent, SkillsPanelAgent)
      .acceptedBy(CopyArbiter)
      .joinQuorum({ min: 2, max: 3 })
      .onError(QuorumNotReachedError, toFinish(PanelFailedWorkflowFinish))
      .toAgent(PanelSummaryAgent)
      .toFinish(PanelReviewWorkflowFinish),
  ],
})
export class CopiesPanelWorkflow {}

/** A panel whose instance may crash: its deadline far, its ends logged for the other instance. */
@Workflow({
  name: "recovery-panel-workflow",
  version: "1.0.0",
  flow: [
    onStart(PanelWorkflowStart)
      .toParallelAgents(...PANEL)
      .joinQuorum({ min: 2, max: 3, deadline: seconds(300) })
      .toAgent(PanelSummaryAgent)
      .toFinish(PanelReviewWorkflowFinish),
  ],
})
export class RecoveryPanelWorkflow {}

@Workflow({
  name: "deal-panel-workflow",
  version: "1.0.0",
  flow: [
    onStart(DealPanelWorkflowStart)
      .toParallelAgents(LegalPanelAgent, CriticPanelAgent, FastPanelAgent)
      .joinQuorumGroups(
        groupFrom([LegalPanelAgent, CriticPanelAgent])
          .priority(1)
          .toAgent(DealReportPanelAgent)
          .toFinish(DealReportPanelWorkflowFinish),
        groupFrom([CriticPanelAgent])
          .priority(2)
          .toFinish(SecondOpinionPanelWorkflowFinish),
        groupFrom([FastPanelAgent])
          .priority(3)
          .toFinish(QuickRejectPanelWorkflowFinish),
        { deadline: seconds(60) },
      )
      .onError(QuorumNotReachedError, toFinish(NoQuorumPanelWorkflowFinish)),
  ],
})
export class DealPanelWorkflow {}

@Application({
  name: "quick-panel-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [QuickPanelWorkflow],
  observers: [QuorumLog],
  budgets: TEST_BUDGETS,
})
export class QuickPanelApplication {}

@Application({
  name: "checked-panel-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [CheckedPanelWorkflow],
  observers: [QuorumLog],
  budgets: TEST_BUDGETS,
})
export class CheckedPanelApplication {}

@Application({
  name: "strict-panel-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [StrictPanelWorkflow],
  budgets: TEST_BUDGETS,
})
export class StrictPanelApplication {}

@Application({
  name: "model-panel-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ModelPanelWorkflow],
  budgets: TEST_BUDGETS,
})
export class ModelPanelApplication {}

@Application({
  name: "chain-panel-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ChainPanelWorkflow],
  budgets: TEST_BUDGETS,
})
export class ChainPanelApplication {}

@Application({
  name: "any-of-panel-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [AnyOfPanelWorkflow],
  budgets: TEST_BUDGETS,
})
export class AnyOfPanelApplication {}

@Application({
  name: "item-panel-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ItemPanelWorkflow],
  budgets: TEST_BUDGETS,
})
export class ItemPanelApplication {}

@Application({
  name: "copies-panel-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [CopiesPanelWorkflow],
  budgets: TEST_BUDGETS,
})
export class CopiesPanelApplication {}

@Application({
  name: "deal-panel-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [DealPanelWorkflow],
  observers: [QuorumLog],
  budgets: TEST_BUDGETS,
})
export class DealPanelApplication {}

@Application({
  name: "recovery-panel-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [RecoveryPanelWorkflow],
  observers: [RecoveryLog, QuorumLog],
  providers: [MortalExecutionLeaseRepository, StampedExecutionRecordRepository],
  budgets: TEST_BUDGETS,
})
export class RecoveryPanelApplication {}

@Application({
  name: "chat-panel-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ChatPanelWorkflow],
  budgets: TEST_BUDGETS,
})
export class ChatPanelApplication {}
