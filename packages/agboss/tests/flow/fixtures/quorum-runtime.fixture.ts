import { StepError } from "../../../src/core/error-families/step-errors.js";
import { Application } from "../../../src/application/application.js";
import { Workflow, Ttl } from "../../../src/index.js";
import { seconds } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "./budgets.js";
import {
  MortalExecutionLeaseRepository,
  RecoveryLog,
  StampedExecutionRecordRepository,
} from "../../infrastructure/fixtures/recovery.workflow.js";
import { onStart, toAgent, toFinish } from "../../helpers/flow.js";
import {
  CopyArbiter,
  CriticPanelAgent,
  DealPanelWorkflowStart,
  DealReportPanelAgent,
  DealReportPanelWorkflowFinish,
  EvenItemArbiter,
  FastPanelAgent,
  HirePanelAgent,
  HybridPanelArbiter,
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
import { TestModelProvider } from "../../../src/testing/test-model-provider.js";

/**
 * #279 PR 2 — quorums at run time, one application per workflow: any two of three; a quorum with an
 * arbiter, `max` and a deadline; one without `.onError`; a model arbiter and a hybrid one, `.inParallel([…])` and `.forEachItem(…)` quorums;
 * a per-item and a copies launch with code arbiters reading `ExecutionContext`; groups with priority.
 */

const PANEL = [SkillsPanelAgent, RisksPanelAgent, HirePanelAgent] as const;

@Workflow({
  name: "quick-panel-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PanelWorkflowStart)
      .inParallel(PANEL.map((agent) => toAgent(agent)))
      .joinQuorum({ min: 2 })
      .toAgent(PanelSummaryAgent)
      .toFinish(PanelReviewWorkflowFinish),
  ],
})
export class QuickPanelWorkflow {}

@Workflow({
  name: "checked-panel-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PanelWorkflowStart)
      .inParallel(PANEL.map((agent) => toAgent(agent)))
      .arbitratedBy(InRangeArbiter)
      .joinQuorum({ min: 2, max: 3, deadline: seconds(30) })
      .onError(StepError.QuorumNotReached, toFinish(PanelFailedWorkflowFinish))
      .onError(StepError.Arbiter, toFinish(PanelUnjudgedWorkflowFinish))
      .toAgent(PanelSummaryAgent)
      .toFinish(PanelReviewWorkflowFinish),
  ],
})
export class CheckedPanelWorkflow {}

@Workflow({
  name: "strict-panel-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PanelWorkflowStart)
      .inParallel(PANEL.map((agent) => toAgent(agent)))
      .arbitratedBy(InRangeArbiter)
      .joinQuorum({ min: 2 })
      .toAgent(PanelSummaryAgent)
      .toFinish(PanelReviewWorkflowFinish),
  ],
})
export class StrictPanelWorkflow {}

@Workflow({
  name: "model-panel-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PanelWorkflowStart)
      .inParallel(PANEL.map((agent) => toAgent(agent)))
      .arbitratedBy(PanelModelArbiter)
      .joinQuorum({ min: 2, max: 3 })
      .onError(StepError.Arbiter, toFinish(PanelUnjudgedWorkflowFinish))
      .toAgent(PanelSummaryAgent)
      .toFinish(PanelReviewWorkflowFinish),
  ],
})
export class ModelPanelWorkflow {}

@Workflow({
  name: "chat-panel-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PanelWorkflowStart)
      .inParallel(PANEL.map((agent) => toAgent(agent)))
      .arbitratedBy(PanelChatArbiter)
      .joinQuorum({ min: 2, max: 3 })
      .toAgent(PanelSummaryAgent)
      .toFinish(PanelReviewWorkflowFinish),
  ],
})
export class ChatPanelWorkflow {}

/** One hybrid arbiter in place of a chain of a code and a model arbiter: its code asks its own model for what it cannot decide (#1283). */
@Workflow({
  name: "hybrid-panel-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PanelWorkflowStart)
      .inParallel(PANEL.map((agent) => toAgent(agent)))
      .arbitratedBy(HybridPanelArbiter)
      .joinQuorum({ min: 1, max: 3 })
      .onError(StepError.Arbiter, toFinish(PanelUnjudgedWorkflowFinish))
      .toAgent(PanelSummaryAgent)
      .toFinish(PanelReviewWorkflowFinish),
  ],
})
export class HybridPanelWorkflow {}

/** `.inParallel([…])` with an arbiter and a quorum (#1282): the branches of any kind, one arbiter judges them. */
@Workflow({
  name: "arbitrated-panel-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PanelWorkflowStart)
      .inParallel([toAgent(SkillsPanelAgent), toAgent(RisksPanelAgent), toAgent(HirePanelAgent)])
      .arbitratedBy(InRangeArbiter)
      .joinQuorum({ min: 2, max: 3 })
      .onError(StepError.QuorumNotReached, toFinish(PanelFailedWorkflowFinish))
      .onError(StepError.Arbiter, toFinish(PanelUnjudgedWorkflowFinish))
      .toAgent(PanelSummaryAgent)
      .toFinish(PanelReviewWorkflowFinish),
  ],
})
export class ArbitratedPanelWorkflow {}

/** `.forEachItem(…)` with an arbiter and a quorum (#1282): one run per item, the arbiter reads which item it is. */
@Workflow({
  name: "each-item-panel-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  executionLimits: { maxSteps: 10 },
  flow: [
    onStart(PanelItemsWorkflowStart)
      .forEachItem(toAgent(SkillsPanelAgent), { takeFirst: 5 })
      .arbitratedBy(EvenItemArbiter)
      .joinQuorum({ min: 3 })
      .toAgent(PanelSummaryAgent)
      .toFinish(PanelReviewWorkflowFinish),
  ],
})
export class EachItemPanelWorkflow {}

@Workflow({
  name: "item-panel-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  executionLimits: { maxSteps: 10 },
  flow: [
    onStart(PanelItemsWorkflowStart)
      .forEachItem(toAgent(SkillsPanelAgent), { takeFirst: 5 })
      .arbitratedBy(EvenItemArbiter)
      .joinQuorum({ min: 3 })
      .toAgent(PanelSummaryAgent)
      .toFinish(PanelReviewWorkflowFinish),
  ],
})
export class ItemPanelWorkflow {}

@Workflow({
  name: "copies-panel-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PanelWorkflowStart)
      .inParallel([toAgent(SkillsPanelAgent), toAgent(SkillsPanelAgent), toAgent(SkillsPanelAgent)])
      .arbitratedBy(CopyArbiter)
      .joinQuorum({ min: 2, max: 3 })
      .onError(StepError.QuorumNotReached, toFinish(PanelFailedWorkflowFinish))
      .toAgent(PanelSummaryAgent)
      .toFinish(PanelReviewWorkflowFinish),
  ],
})
export class CopiesPanelWorkflow {}

/** A panel whose instance may crash: its deadline far, its ends logged for the other instance. */
@Workflow({
  name: "recovery-panel-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(PanelWorkflowStart)
      .inParallel(PANEL.map((agent) => toAgent(agent)))
      .joinQuorum({ min: 2, max: 3, deadline: seconds(300) })
      .toAgent(PanelSummaryAgent)
      .toFinish(PanelReviewWorkflowFinish),
  ],
})
export class RecoveryPanelWorkflow {}

@Workflow({
  name: "deal-panel-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(DealPanelWorkflowStart)
      .inParallel([toAgent(LegalPanelAgent), toAgent(CriticPanelAgent), toAgent(FastPanelAgent)])
      .joinQuorumGroups({ deadline: seconds(60) })
      .onError(StepError.QuorumNotReached, toFinish(NoQuorumPanelWorkflowFinish))
      .onGroup(
        [LegalPanelAgent, CriticPanelAgent],
        { priority: 1 },
        toAgent(DealReportPanelAgent)
          .toFinish(DealReportPanelWorkflowFinish),
      )
      .onGroup([CriticPanelAgent], { priority: 2 }, toFinish(SecondOpinionPanelWorkflowFinish))
      .onGroup([FastPanelAgent], { priority: 3 }, toFinish(QuickRejectPanelWorkflowFinish)),
  ],
})
export class DealPanelWorkflow {}

@Application({
  name: "quick-panel-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [QuickPanelWorkflow],
  observers: [QuorumLog],
  budgets: TEST_BUDGETS,
})
export class QuickPanelApplication {}

@Application({
  name: "checked-panel-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [CheckedPanelWorkflow],
  observers: [QuorumLog],
  budgets: TEST_BUDGETS,
})
export class CheckedPanelApplication {}

@Application({
  name: "strict-panel-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [StrictPanelWorkflow],
  budgets: TEST_BUDGETS,
})
export class StrictPanelApplication {}

@Application({
  name: "model-panel-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [ModelPanelWorkflow],
  budgets: TEST_BUDGETS,
})
export class ModelPanelApplication {}

@Application({
  name: "hybrid-panel-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [HybridPanelWorkflow],
  budgets: TEST_BUDGETS,
})
export class HybridPanelApplication {}

@Application({
  name: "arbitrated-panel-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [ArbitratedPanelWorkflow],
  budgets: TEST_BUDGETS,
})
export class ArbitratedPanelApplication {}

@Application({
  name: "each-item-panel-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [EachItemPanelWorkflow],
  budgets: TEST_BUDGETS,
})
export class EachItemPanelApplication {}

@Application({
  name: "item-panel-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [ItemPanelWorkflow],
  budgets: TEST_BUDGETS,
})
export class ItemPanelApplication {}

@Application({
  name: "copies-panel-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [CopiesPanelWorkflow],
  budgets: TEST_BUDGETS,
})
export class CopiesPanelApplication {}

@Application({
  name: "deal-panel-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [DealPanelWorkflow],
  observers: [QuorumLog],
  budgets: TEST_BUDGETS,
})
export class DealPanelApplication {}

@Application({
  name: "recovery-panel-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [RecoveryPanelWorkflow],
  observers: [RecoveryLog, QuorumLog],
  providers: [MortalExecutionLeaseRepository, StampedExecutionRecordRepository],
  budgets: TEST_BUDGETS,
})
export class RecoveryPanelApplication {}

@Application({
  name: "chat-panel-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [ChatPanelWorkflow],
  budgets: TEST_BUDGETS,
})
export class ChatPanelApplication {}
