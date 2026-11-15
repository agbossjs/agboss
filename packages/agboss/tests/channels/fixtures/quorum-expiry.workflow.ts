import { Text } from "../../../src/dto/index.js";
import {
  Agent,
  Channel,
  DecidedBy,
  FailurePolicy,
  Router,
  SpawnPolicy,
  type RouterAnswerOf,
  type RouterHandler,
  ChannelOf,
  ChannelOutcome,
  ChannelRole,
  EmptyEnvironment,
  Injectable,
  listOf,
  PauseAnswerer,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ChannelAsk,
  type OnExecutionEnd,
  type OnExecutionError,
  type ExecutionEndEvent,
  type ExecutionErrorEvent,
  type OnQuorumDecided,
  type Produced,
  type QuorumDecidedEvent,
  type ToolHandler,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { groupFrom } from "../../../src/flow/path-builder.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { RecordingLogger } from "../../helpers/log.js";
import { start, toFinish } from "../../helpers/flow.js";
import { PauseExpiredError } from "../../../src/flow/runtime/pause-expired-error.js";
import { hours, minutes } from "../../../src/units/index.js";
import {
  FraudAgent,
  PolicyAgent,
  RefundScoreDto,
  RiskAgent,
} from "./refund-panel.workflow.js";
import {
  FinanceDeskRefundApprovalChannel,
  PauseLog,
  RefundDoneDto,
  RefundRequestDto,
  SeenPausedExecutionRepository,
  type SentAsk,
} from "./pauses.workflow.js";

/**
 * #945 — a panel whose reviewer never answers. The pauses of `PolicyAgent`, `RiskAgent` and
 * `FraudAgent` (`RefundTool`, no deadline of its own) are bound by their quorum's deadline of one
 * hour; the `Short…` reviewers' tool gives the desk 30 minutes, earlier than the quorum's. What the
 * quorums decided and how the workflows ended is in `qe`, reset per test.
 */

export const qe = {
  /** The quorums decided (`onQuorumDecided`), in order. */
  decided: [] as QuorumDecidedEvent[],
  /** The scores each finish read, in the order the quorum counted them. */
  finished: [] as string[][],
  /** The executions that ended at a finish. */
  ended: [] as ExecutionEndEvent[],
  /** The errors executions failed with. */
  errors: [] as Error[],
  /** The asks the short desk was sent. */
  shortAsks: [] as SentAsk[],
};

export function resetQuorumExpiry(): void {
  qe.decided.length = 0;
  qe.finished.length = 0;
  qe.ended.length = 0;
  qe.errors.length = 0;
  qe.shortAsks.length = 0;
}

@Injectable()
export class QuorumExpiryLog implements OnQuorumDecided, OnExecutionEnd, OnExecutionError {
  onQuorumDecided(event: QuorumDecidedEvent): void {
    qe.decided.push(event);
  }

  onExecutionEnd(event: ExecutionEndEvent): void {
    qe.ended.push(event);
  }

  onExecutionError(event: ExecutionErrorEvent): void {
    qe.errors.push(event.error);
  }
}

/** What a finish reads: the counted scores. */
interface ScoresInput {
  readonly scores: readonly Produced<RefundScoreDto, unknown>[];
}

const record = (input: ScoresInput): RefundDoneDto => {
  qe.finished.push(input.scores.map((score) => String(score.value.score)));
  return { orderId: input.scores.map((score) => String(score.value.score))
    .join(",") };
};

@WorkflowStart({
  name: "quorum-expiry-workflow-start",
  description: "The order to refund",
  input: RefundRequestDto,
})
export class QuorumExpiryWorkflowStart {}

@WorkflowFinish({
  name: "quorum-expiry-workflow-finish",
  description: "The counted scores",
  input: { scores: listOf(RefundScoreDto) },
  output: RefundDoneDto,
})
export class QuorumExpiryWorkflowFinish {
  finish(input: ScoresInput): RefundDoneDto {
    return record(input);
  }
}

@WorkflowFinish({
  name: "quorum-expiry-second-workflow-finish",
  description: "The second group's scores",
  input: { scores: listOf(RefundScoreDto) },
  output: RefundDoneDto,
})
export class QuorumExpirySecondWorkflowFinish {
  finish(input: ScoresInput): RefundDoneDto {
    return record(input);
  }
}

/** Three reviewers, any two decide, up to three count, an hour. */
@Workflow({
  name: "quorum-expiry-workflow",
  version: "1.0.0",
  flow: [
    start(QuorumExpiryWorkflowStart)
      .returns(RefundRequestDto)
      .toParallelAgents(PolicyAgent, RiskAgent, FraudAgent)
      .joinQuorum({ min: 2, max: 3, deadline: hours(1) })
      .returns(listOf(RefundScoreDto))
      .toFinish(QuorumExpiryWorkflowFinish),
  ],
})
export class QuorumExpiryWorkflow {}

@WorkflowStart({
  name: "quorum-expiry-one-workflow-start",
  description: "The order to refund",
  input: RefundRequestDto,
})
export class QuorumExpiryOneWorkflowStart {}

/** The same panel where one counted answer is enough. */
@Workflow({
  name: "quorum-expiry-one-workflow",
  version: "1.0.0",
  flow: [
    start(QuorumExpiryOneWorkflowStart)
      .returns(RefundRequestDto)
      .toParallelAgents(PolicyAgent, RiskAgent, FraudAgent)
      .joinQuorum({ min: 1, max: 3, deadline: hours(1) })
      .returns(listOf(RefundScoreDto))
      .toFinish(QuorumExpiryWorkflowFinish),
  ],
})
export class QuorumExpiryOneWorkflow {}

/** The 30-minutes desk's channel role: its tool gives it 30 minutes, the quorum 1 hour. */
@ChannelRole({
  name: "short-refund-approval-channel",
  description: "Approves refunds within 30 minutes",
  approves: RefundRequestDto,
  answerer: PauseAnswerer.Channel,
})
export abstract class ShortRefundApprovalChannel extends ChannelOf<ShortRefundApprovalChannel> {}

@Channel({ name: "short-desk-refund-approval-channel", description: "Asks the short desk" })
export class ShortDeskRefundApprovalChannel extends ShortRefundApprovalChannel {
  send(
    ask: ChannelAsk<ShortRefundApprovalChannel>,
  ): Promise<ChannelOutcome<ShortRefundApprovalChannel>> {
    qe.shortAsks.push({ pauseId: ask.pauseId, orderId: ask.value.orderId });
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@Tool({
  name: "short-refund-tool",
  description: "Refunds an order, the desk has 30 minutes",
  channel: ShortRefundApprovalChannel,
  expiresIn: minutes(30),
  input: RefundRequestDto,
  output: RefundDoneDto,
})
export class ShortRefundTool implements ToolHandler<RefundRequestDto, RefundDoneDto> {
  run({ orderId }: RefundRequestDto): Promise<RefundDoneDto> {
    return Promise.resolve({ orderId });
  }
}

const MODEL = "moonshotai/kimi-k2.6";

@Agent({
  name: "short-policy-agent",
  description: "Checks the policy; its desk has 30 minutes",
  prompt: "Score the refund.",
  model: MODEL,
  tools: [ShortRefundTool],
  input: { request: RefundRequestDto },
  output: RefundScoreDto,
})
export class ShortPolicyAgent {}

@Agent({
  name: "short-risk-agent",
  description: "Checks the risk; its desk has 30 minutes",
  prompt: "Score the refund.",
  model: MODEL,
  tools: [ShortRefundTool],
  input: { request: RefundRequestDto },
  output: RefundScoreDto,
})
export class ShortRiskAgent {}

@Agent({
  name: "short-fraud-agent",
  description: "Checks for fraud; its desk has 30 minutes",
  prompt: "Score the refund.",
  model: MODEL,
  tools: [ShortRefundTool],
  input: { request: RefundRequestDto },
  output: RefundScoreDto,
})
export class ShortFraudAgent {}

@WorkflowStart({
  name: "quorum-expiry-short-workflow-start",
  description: "The order to refund",
  input: RefundRequestDto,
})
export class QuorumExpiryShortWorkflowStart {}

/** Own deadlines (30 minutes) earlier than the quorum's hour; no `.onJoinError`: the launch fails. */
@Workflow({
  name: "quorum-expiry-short-workflow",
  version: "1.0.0",
  flow: [
    start(QuorumExpiryShortWorkflowStart)
      .returns(RefundRequestDto)
      .toParallelAgents(ShortPolicyAgent, ShortRiskAgent, ShortFraudAgent)
      .joinQuorum({ min: 2, max: 3, deadline: hours(1) })
      .returns(listOf(RefundScoreDto))
      .toFinish(QuorumExpiryWorkflowFinish),
  ],
})
export class QuorumExpiryShortWorkflow {}

@WorkflowStart({
  name: "quorum-expiry-short-one-workflow-start",
  description: "The order to refund",
  input: RefundRequestDto,
})
export class QuorumExpiryShortOneWorkflowStart {}

@Workflow({
  name: "quorum-expiry-short-one-workflow",
  version: "1.0.0",
  flow: [
    start(QuorumExpiryShortOneWorkflowStart)
      .returns(RefundRequestDto)
      .toParallelAgents(ShortPolicyAgent, ShortRiskAgent, ShortFraudAgent)
      .joinQuorum({ min: 1, max: 3, deadline: hours(1) })
      .returns(listOf(RefundScoreDto))
      .toFinish(QuorumExpiryWorkflowFinish),
  ],
})
export class QuorumExpiryShortOneWorkflow {}

@Agent({
  name: "quick-score-agent",
  description: "Scores at once",
  prompt: "Score the refund.",
  model: MODEL,
  input: { request: RefundRequestDto },
  output: RefundScoreDto,
})
export class QuickScoreAgent {}

@WorkflowStart({
  name: "quorum-expiry-groups-workflow-start",
  description: "The order to refund",
  input: RefundRequestDto,
})
export class QuorumExpiryGroupsWorkflowStart {}

/** The priority group needs all three reviewers; the other group is the quick scorer alone. */
@Workflow({
  name: "quorum-expiry-groups-workflow",
  version: "1.0.0",
  flow: [
    start(QuorumExpiryGroupsWorkflowStart)
      .returns(RefundRequestDto)
      .toParallelAgents(PolicyAgent, RiskAgent, FraudAgent, QuickScoreAgent)
      .joinQuorumGroups(
        groupFrom([PolicyAgent, RiskAgent, FraudAgent])
          .priority(1)
          .returns(listOf(RefundScoreDto))
          .toFinish(QuorumExpiryWorkflowFinish),
        groupFrom([QuickScoreAgent])
          .priority(2)
          .returns(listOf(RefundScoreDto))
          .toFinish(QuorumExpirySecondWorkflowFinish),
        { deadline: hours(1) },
      ),
  ],
})
export class QuorumExpiryGroupsWorkflow {}

@WorkflowStart({
  name: "plain-expiry-workflow-start",
  description: "The order to refund",
  input: RefundRequestDto,
})
export class PlainExpiryWorkflowStart {}

@WorkflowFinish({
  name: "plain-expiry-escalated-workflow-finish",
  description: "The panel failed on an expiry: escalated",
  output: RefundRequestDto,
})
export class PlainExpiryEscalatedWorkflowFinish {}

/** A plain `.join()` (FailFast): the short desk's expiry fails the launch; the third waits. */
@Workflow({
  name: "plain-expiry-workflow",
  version: "1.0.0",
  flow: [
    start(PlainExpiryWorkflowStart)
      .returns(RefundRequestDto)
      .toParallelAgents(ShortPolicyAgent, ShortRiskAgent, PolicyAgent)
      .join()
      .returns(listOf(RefundScoreDto))
      .toFinish(QuorumExpiryWorkflowFinish),
  ],
})
export class PlainExpiryWorkflow {}

@WorkflowStart({
  name: "plain-expiry-handled-workflow-start",
  description: "The order to refund",
  input: RefundRequestDto,
})
export class PlainExpiryHandledWorkflowStart {}

/** The same join with `.onJoinError(PauseExpiredError, …)`. */
@Workflow({
  name: "plain-expiry-handled-workflow",
  version: "1.0.0",
  flow: [
    start(PlainExpiryHandledWorkflowStart)
      .returns(RefundRequestDto)
      .toParallelAgents(ShortPolicyAgent, ShortRiskAgent, PolicyAgent)
      .join()
      .onJoinError(PauseExpiredError, toFinish(PlainExpiryEscalatedWorkflowFinish))
      .returns(listOf(RefundScoreDto))
      .toFinish(QuorumExpiryWorkflowFinish),
  ],
})
export class PlainExpiryHandledWorkflow {}

@Router({
  name: "skip-panel-router",
  description: "Launches both desks; the short policy desk's failure drops it",
  decidedBy: DecidedBy.Code,
  input: { request: RefundRequestDto },
  routes: [
    { target: ShortPolicyAgent, spawn: SpawnPolicy.Always, failure: FailurePolicy.Skip },
    { target: ShortRiskAgent, spawn: SpawnPolicy.OnDemand },
  ],
})
export class SkipPanelRouter implements RouterHandler<SkipPanelRouter> {
  route(): RouterAnswerOf<SkipPanelRouter> {
    return [ShortRiskAgent];
  }
}

@WorkflowStart({
  name: "skip-expiry-workflow-start",
  description: "The order to refund",
  input: RefundRequestDto,
})
export class SkipExpiryWorkflowStart {}

/** A plain join where the short policy desk's branch is `Skip`: its expiry drops it. */
@Workflow({
  name: "skip-expiry-workflow",
  version: "1.0.0",
  flow: [
    start(SkipExpiryWorkflowStart)
      .returns(RefundRequestDto)
      .toRouter(SkipPanelRouter)
      .toParallelAgents(ShortPolicyAgent, ShortRiskAgent)
      .join()
      .returns(listOf(RefundScoreDto))
      .toFinish(QuorumExpiryWorkflowFinish),
  ],
})
export class SkipExpiryWorkflow {}

@Application({
  name: "quorum-expiry-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [
    QuorumExpiryWorkflow,
    QuorumExpiryOneWorkflow,
    QuorumExpiryShortWorkflow,
    QuorumExpiryShortOneWorkflow,
    QuorumExpiryGroupsWorkflow,
    PlainExpiryWorkflow,
    PlainExpiryHandledWorkflow,
    SkipExpiryWorkflow,
  ],
  providers: [
    FinanceDeskRefundApprovalChannel,
    ShortDeskRefundApprovalChannel,
    SeenPausedExecutionRepository,
    RecordingLogger,
  ],
  observers: [PauseLog, QuorumExpiryLog],
  budgets: TEST_BUDGETS,
})
export class QuorumExpiryApplication {}
