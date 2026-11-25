import { StepError } from "../../../src/core/error-families/step-errors.js";
import {
  Action,
  Agent,
  Arbiter,
  Arbitrate,
  Channel,
  ChannelOutcome,
  EmptyEnvironment,
  ExternalTask,
  Injectable,
  inline,
  Metadata,
  PauseRespondent,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  listOf,
  type ChannelAsk,
  Ttl,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { Bool, PlainTextDto, Text, WorkflowFinishTextDto } from "../../../src/dto/index.js";
import { optional } from "../../../src/flow/dto-wrappers.js";
import { LimitError } from "../../../src/core/error-families/limit-errors.js";
import {
  onStart,
  toAction,
  toAgent,
  toExternalTask,
  toFinish,
  toWorkflow,
} from "../../../src/flow/builder.js";
import { days, hours } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "./budgets.js";
import { WorkflowStartTextDto } from "./dtos.js";
import { TestModelProvider } from "../../../src/testing/test-model-provider.js";

/**
 * #1306 — `toExternalTask(…)` in parallel launches: a committee of external parties signs a contract
 * side by side (`.inParallel([…])`), a budget approval asks one external task per owner
 * (`.forEachItem(…)`); `@Arbiter` counts only an approved answer, so `{ approved: false }` is never
 * a vote for a quorum.
 */

export class ContractDto {
  @Text({ prompt: "the contract's title" })
  title!: string;
}

export class SignOffDto {
  @Bool({ prompt: "whether the party signs" })
  approved!: boolean;

  @Text({ prompt: "why", optional: true })
  note?: string;
}

export class OwnerAskDto {
  @Text({ prompt: "the budget owner" })
  owner!: string;
}

export class SignedDto {
  @Text()
  status!: string;
}

/** What the committee's channels were asked, across the instances of a test. */
@Injectable()
export class CommitteeInbox {
  readonly asked: ChannelAsk<unknown>[] = [];
}

@ExternalTask({
  name: "legal-sign-off-external-task",
  description: "The lawyer signs the contract off",
  input: ContractDto,
  output: SignOffDto,
  respondent: PauseRespondent.Owner,
  timeout: hours(24),
})
export class LegalSignOffExternalTask {}

@ExternalTask({
  name: "security-sign-off-external-task",
  description: "Security signs the contract off",
  input: ContractDto,
  output: SignOffDto,
  respondent: PauseRespondent.Owner,
  timeout: hours(24),
})
export class SecuritySignOffExternalTask {}

@ExternalTask({
  name: "finance-director-external-task",
  description: "The finance director signs the contract off",
  input: ContractDto,
  output: SignOffDto,
  respondent: PauseRespondent.Owner,
  timeout: hours(24),
})
export class FinanceDirectorExternalTask {}

@ExternalTask({
  name: "budget-owner-external-task",
  description: "One budget owner approves their share",
  input: OwnerAskDto,
  output: SignOffDto,
  respondent: PauseRespondent.Owner,
  timeout: hours(24),
})
export class BudgetOwnerExternalTask {}

@Channel({
  name: "legal-inbox-channel",
  description: "Legal's inbox",
  target: LegalSignOffExternalTask,
  ttl: days(14),
  deps: [CommitteeInbox],
})
export class LegalInboxChannel {
  constructor(private readonly inbox: CommitteeInbox) {}

  send(ask: ChannelAsk<LegalSignOffExternalTask>): ChannelOutcome<LegalSignOffExternalTask> {
    this.inbox.asked.push(ask);
    return ChannelOutcome.awaitReply();
  }
}

@Channel({
  name: "security-inbox-channel",
  description: "Security's inbox",
  target: SecuritySignOffExternalTask,
  ttl: days(14),
  deps: [CommitteeInbox],
})
export class SecurityInboxChannel {
  constructor(private readonly inbox: CommitteeInbox) {}

  send(ask: ChannelAsk<SecuritySignOffExternalTask>): ChannelOutcome<SecuritySignOffExternalTask> {
    this.inbox.asked.push(ask);
    return ChannelOutcome.awaitReply();
  }
}

@Channel({
  name: "finance-inbox-channel",
  description: "The finance director's inbox",
  target: FinanceDirectorExternalTask,
  ttl: days(14),
  deps: [CommitteeInbox],
})
export class FinanceInboxChannel {
  constructor(private readonly inbox: CommitteeInbox) {}

  send(ask: ChannelAsk<FinanceDirectorExternalTask>): ChannelOutcome<FinanceDirectorExternalTask> {
    this.inbox.asked.push(ask);
    return ChannelOutcome.awaitReply();
  }
}

@Channel({
  name: "budget-owner-inbox-channel",
  description: "A budget owner's inbox",
  target: BudgetOwnerExternalTask,
  ttl: days(14),
  deps: [CommitteeInbox],
})
export class BudgetOwnerInboxChannel {
  constructor(private readonly inbox: CommitteeInbox) {}

  send(ask: ChannelAsk<BudgetOwnerExternalTask>): ChannelOutcome<BudgetOwnerExternalTask> {
    this.inbox.asked.push(ask);
    return ChannelOutcome.awaitReply();
  }
}

/** Only an approving answer counts: a refusal is a valid answer and no vote. */
@Arbiter({ name: "sign-off-arbiter" })
export class SignOffArbiter {
  @Arbitrate(LegalSignOffExternalTask, SecuritySignOffExternalTask, FinanceDirectorExternalTask)
  isApproved(answer: SignOffDto): boolean {
    return answer.approved;
  }
}

/** The same rule for the budget owners of a `.forEachItem(…)`. */
@Arbiter({ name: "budget-approval-arbiter" })
export class BudgetApprovalArbiter {
  @Arbitrate(BudgetOwnerExternalTask)
  isApproved(answer: SignOffDto): boolean {
    return answer.approved;
  }
}

@WorkflowStart({
  name: "contract-committee-workflow-start",
  description: "The contract to sign",
  input: WorkflowStartTextDto,
})
export class ContractCommitteeWorkflowStart {}

@WorkflowStart({
  name: "budget-approval-workflow-start",
  description: "The budget owners, comma-separated",
  input: WorkflowStartTextDto,
})
export class BudgetApprovalWorkflowStart {}

@WorkflowStart({
  name: "contract-groups-workflow-start",
  description: "The contract to sign by groups",
  input: WorkflowStartTextDto,
})
export class ContractGroupsWorkflowStart {}

@Action({
  name: "draft-contract-action",
  description: "Drafts the contract",
  input: { message: WorkflowStartTextDto },
  output: ContractDto,
})
export class DraftContractAction {
  async execute(input: { readonly message: WorkflowStartTextDto }): Promise<ContractDto> {
    await Promise.resolve();
    return { title: input.message.text };
  }
}

/** Signs once the parties' answers are in: it reads what the quorum counted. */
@Action({
  name: "sign-contract-action",
  description: "Signs the contract",
  input: { signOffs: listOf(SignOffDto) },
  output: SignedDto,
})
export class SignContractAction {
  async execute(): Promise<SignedDto> {
    await Promise.resolve();
    return { status: "signed" };
  }
}

@Action({
  name: "sign-as-finance-action",
  description: "Signs on the finance director's word alone",
  input: { signOffs: listOf(SignOffDto) },
  output: SignedDto,
})
export class SignAsFinanceAction {
  async execute(): Promise<SignedDto> {
    await Promise.resolve();
    return { status: "signed by finance" };
  }
}

@Action({
  name: "sign-as-panel-action",
  description: "Signs on legal's and security's word together",
  input: { signOffs: listOf(SignOffDto) },
  output: SignedDto,
})
export class SignAsPanelAction {
  async execute(): Promise<SignedDto> {
    await Promise.resolve();
    return { status: "signed by legal and security" };
  }
}

@Action({
  name: "review-notes-action",
  description: "Reads what the note and the checked contract gave",
  input: { note: optional(WorkflowFinishTextDto), checked: optional(ContractDto) },
  output: SignedDto,
})
export class ReviewNotesAction {
  async execute(): Promise<SignedDto> {
    await Promise.resolve();
    return { status: "reviewed" };
  }
}

@WorkflowFinish({
  name: "contract-signed-workflow-finish",
  description: "The contract is signed",
  output: SignedDto,
})
export class ContractSignedWorkflowFinish {}

@WorkflowFinish({
  name: "contract-rejected-workflow-finish",
  description: "The committee did not agree: the request, as it came",
  output: WorkflowStartTextDto,
})
export class ContractRejectedWorkflowFinish {}

/** Two of the three parties sign; the third's pause is withdrawn once the quorum is met. */
@Workflow({
  name: "contract-committee-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  executionLimits: { maxSteps: 20 },
  flow: [
    onStart(ContractCommitteeWorkflowStart)
      .toAction(DraftContractAction)
      .inParallel([
        toExternalTask(LegalSignOffExternalTask),
        toExternalTask(SecuritySignOffExternalTask),
        toExternalTask(FinanceDirectorExternalTask),
      ])
      .arbitratedBy(SignOffArbiter)
      .joinQuorum({ min: 2, deadline: hours(2) })
      .onError(StepError.QuorumNotReached, toFinish(ContractRejectedWorkflowFinish))
      .toAction(SignContractAction)
      .toFinish(ContractSignedWorkflowFinish),
  ],
})
export class ContractCommitteeWorkflow {}

@Action({
  name: "load-budget-owners-action",
  description: "The owners whose approval is needed",
  input: { message: WorkflowStartTextDto },
  output: listOf(OwnerAskDto),
})
export class LoadBudgetOwnersAction {
  async execute(input: {
    readonly message: WorkflowStartTextDto;
  }): Promise<readonly OwnerAskDto[]> {
    await Promise.resolve();
    return input.message.text.split(",")
      .map((owner) => ({ owner: owner.trim() }));
  }
}

/** One external task per owner; three approvals are enough. */
@Workflow({
  name: "budget-approval-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  executionLimits: { maxSteps: 30 },
  flow: [
    onStart(BudgetApprovalWorkflowStart)
      .toAction(LoadBudgetOwnersAction)
      .forEachItem(toExternalTask(BudgetOwnerExternalTask), { maxItems: 5 })
      .arbitratedBy(BudgetApprovalArbiter)
      .joinQuorum({ min: 2, deadline: hours(2) })
      .onError(LimitError.Items, toFinish(ContractRejectedWorkflowFinish))
      .onError(StepError.QuorumNotReached, toFinish(ContractRejectedWorkflowFinish))
      .toAction(SignContractAction)
      .toFinish(ContractSignedWorkflowFinish),
  ],
})
export class BudgetApprovalWorkflow {}

/** The finance director's signature alone is enough; else legal and security together. */
@Workflow({
  name: "contract-groups-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  executionLimits: { maxSteps: 30 },
  flow: [
    onStart(ContractGroupsWorkflowStart)
      .toAction(DraftContractAction)
      .inParallel([
        toExternalTask(LegalSignOffExternalTask),
        toExternalTask(SecuritySignOffExternalTask),
        toExternalTask(FinanceDirectorExternalTask),
      ])
      .arbitratedBy(SignOffArbiter)
      .joinQuorumGroups({ deadline: hours(2) })
      .onError(StepError.QuorumNotReached, toFinish(ContractRejectedWorkflowFinish))
      .onGroup(
        [FinanceDirectorExternalTask],
        { priority: 1 },
        toAction(SignAsFinanceAction)
          .toFinish(ContractSignedWorkflowFinish),
      )
      .onGroup(
        [LegalSignOffExternalTask, SecuritySignOffExternalTask],
        { priority: 2 },
        toAction(SignAsPanelAction)
          .toFinish(ContractSignedWorkflowFinish),
      ),
  ],
})
export class ContractGroupsWorkflow {}

@Agent({
  name: "committee-note-agent",
  description: "Writes a note on the contract; no output, so its answer is text",
  prompt: inline("Write a note."),
  model: "moonshotai/kimi-k2.6",
  input: { message: WorkflowStartTextDto },
})
export class CommitteeNoteAgent {}

@WorkflowStart({
  name: "committee-child-workflow-start",
  description: "A contract to check",
  input: ContractDto,
})
export class CommitteeChildWorkflowStart {}

@WorkflowFinish({
  name: "committee-child-workflow-finish",
  description: "The checked contract",
  output: ContractDto,
})
export class CommitteeChildWorkflowFinish {}

@Workflow({
  name: "committee-child-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(CommitteeChildWorkflowStart)
    .toFinish(CommitteeChildWorkflowFinish)],
})
export class CommitteeChildWorkflow {}

/** A text agent's answer and a child workflow's output are judged by the same arbiter. */
@Arbiter({ name: "note-arbiter" })
export class NoteArbiter {
  @Arbitrate(CommitteeNoteAgent)
  isNote(answer: WorkflowFinishTextDto): boolean {
    return (
      answer instanceof WorkflowFinishTextDto &&
      answer instanceof PlainTextDto &&
      Metadata.createdBy(answer) === CommitteeNoteAgent &&
      answer.text !== ""
    );
  }

  @Arbitrate(CommitteeChildWorkflow)
  isContract(answer: ContractDto): boolean {
    return Metadata.createdBy(answer) === CommitteeChildWorkflow && answer.title !== "";
  }
}

@WorkflowStart({
  name: "committee-notes-workflow-start",
  description: "The contract to review",
  input: WorkflowStartTextDto,
})
export class CommitteeNotesWorkflowStart {}

@WorkflowFinish({
  name: "committee-notes-workflow-finish",
  description: "The review is in",
  output: SignedDto,
})
export class CommitteeNotesWorkflowFinish {}

/** A text agent and a child workflow in one quorum, judged by `NoteArbiter`. */
@Workflow({
  name: "committee-notes-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  executionLimits: { maxSteps: 30 },
  flow: [
    onStart(CommitteeNotesWorkflowStart)
      .toAction(DraftContractAction)
      .inParallel([toAgent(CommitteeNoteAgent), toWorkflow(CommitteeChildWorkflow)])
      .arbitratedBy(NoteArbiter)
      .joinQuorum({ min: 1 })
      .onError(StepError.QuorumNotReached, toFinish(ContractRejectedWorkflowFinish))
      .toAction(ReviewNotesAction)
      .toFinish(ContractSignedWorkflowFinish),
  ],
})
export class CommitteeNotesWorkflow {}

@Application({
  name: "committee-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [
    ContractCommitteeWorkflow,
    BudgetApprovalWorkflow,
    ContractGroupsWorkflow,
    CommitteeNotesWorkflow,
  ],
  providers: [CommitteeInbox],
  channels: [LegalInboxChannel, SecurityInboxChannel, FinanceInboxChannel, BudgetOwnerInboxChannel],
  budgets: TEST_BUDGETS,
})
export class CommitteeApplication {}
