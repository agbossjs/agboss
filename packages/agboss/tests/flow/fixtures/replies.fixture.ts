import { Channel, Injectable, Tool, type ToolHandler } from "../../../src/components/decorators.js";
import { ChannelOf, type ChannelAsk } from "../../../src/channels/channel-handler.js";
import { ChannelOutcome } from "../../../src/channels/channel-outcome.js";
import { ChannelRole, PauseAnswerer } from "../../../src/channels/channel-role.decorator.js";
import {
  ReplyInterpreter,
  type ReplyInterpreterHandler,
} from "../../../src/channels/reply-interpreter.js";
import { Integer, Text, WorkflowFinishTextDto } from "../../../src/dto/index.js";
import { Agent } from "../../../src/flow/decorators/agent.js";
import { DecidedBy } from "../../../src/flow/decorators/router.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import type { InputOf, OutputOf } from "../../../src/flow/generated-types.js";
import { Application } from "../../../src/application/application.js";
import { EmptyEnvironment } from "../../../src/environments/empty.js";
import { PiiPolicy } from "../../../src/pii/pii-policy.decorator.js";
import { PiiAction, PiiKind, pii } from "../../../src/pii/index.js";
import { minutes } from "../../../src/units/index.js";
import { InMemoryPausedExecutionRepository } from "../../../src/infrastructure/paused-execution.repository.js";
import { InMemoryCostLedgerRepository } from "../../../src/infrastructure/cost-ledger.repository.js";
import { TEST_BUDGETS } from "./budgets.js";
import { WorkflowStartTextDto } from "./dtos.js";
import { start } from "./paths.js";

/**
 * #267 PR 3 — free-text replies: a payout approved by a finance desk that passes the manager's
 * words as they are (a model interpreter reads them), an expense confirmed by the thread's owner
 * through buttons whose value is a small JSON (a code interpreter reads it), and a transfer whose
 * role names no interpreter. What the channels were sent and the tools did is in `replyDesk`.
 */

export class PayoutRequestDto {
  @Text({ prompt: "who is paid" })
  payee!: string;

  @Integer({ prompt: "the amount in cents", min: 1 })
  amountCents!: number;
}

export class ExpenseRequestDto {
  @Text({ prompt: "what the expense is for" })
  purpose!: string;
}

export class TransferRequestDto {
  @Text({ prompt: "the account to transfer to" })
  account!: string;
}

export class ReplyDeskDoneDto {
  @Text()
  status!: string;
}

/** What the channels were sent and what the tools did, across the instances of a test. */
export const replyDesk = {
  asks: [] as ChannelAsk<PayoutApprovalChannel>[],
  confirmations: [] as ChannelAsk<ExpenseApprovalChannel>[],
  transfers: [] as ChannelAsk<TransferApprovalChannel>[],
  payouts: [] as PayoutRequestDto[],
  expenses: [] as string[],
};

/** The application's stores, seen by the tests (an instance shares them with the others). */
export const replyStores = {
  pauses: [] as InMemoryPausedExecutionRepository[],
  ledgers: [] as InMemoryCostLedgerRepository[],
};

export function resetReplyDesk(): void {
  for (const list of Object.values(replyDesk)) list.length = 0;
  for (const list of Object.values(replyStores)) list.length = 0;
}

@Injectable()
export class SeenTreasuryPausedExecutionRepository extends InMemoryPausedExecutionRepository {
  constructor() {
    super();
    replyStores.pauses.push(this);
  }
}

@Injectable()
export class SeenTreasuryCostLedgerRepository extends InMemoryCostLedgerRepository {
  constructor() {
    super();
    replyStores.ledgers.push(this);
  }
}

/** The pause store of the test (the first instance's). */
export function treasuryPauses(): InMemoryPausedExecutionRepository {
  const [store] = replyStores.pauses;
  if (store === undefined) throw new Error("the application has not started");
  return store;
}

/** The cost ledger of the test (the first instance's). */
export function treasuryLedger(): InMemoryCostLedgerRepository {
  const [ledger] = replyStores.ledgers;
  if (ledger === undefined) throw new Error("the application has not started");
  return ledger;
}

/** Reads a manager's words on a payout: approve, refuse, or approve a changed amount. */
@ReplyInterpreter({
  name: "payout-reply-interpreter",
  description: "Turns a finance manager's free-text reply into a payout decision",
  decidedBy: DecidedBy.Model,
  model: "test/payout-reader",
  prompt:
    "The manager answered a payout approval in free text. " +
    "Decide approve / refuse and any changed amount.",
})
export class PayoutReplyInterpreter {}

/** The expense buttons' values, as the chat app sends them back: `{"approved":true}`, … */
@Injectable()
export class ExpenseButtonCodes {
  decisionOf(value: string): OutputOf<ExpenseReplyInterpreter> {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || !("approved" in parsed))
      throw new TypeError(`not an expense button value: ${value}`);
    return { approved: parsed.approved === true };
  }
}

/** Reads the owner's button value with the expense codes; anything else is declined (it throws). */
@ReplyInterpreter({
  name: "expense-reply-interpreter",
  description: "Turns an expense button's value into a decision",
  decidedBy: DecidedBy.Code,
  deps: [ExpenseButtonCodes],
})
export class ExpenseReplyInterpreter implements ReplyInterpreterHandler<ExpenseReplyInterpreter> {
  constructor(private readonly expenseButtonCodes: ExpenseButtonCodes) {}

  interpret(input: InputOf<ExpenseReplyInterpreter>): Promise<OutputOf<ExpenseReplyInterpreter>> {
    return Promise.resolve(this.expenseButtonCodes.decisionOf(input.reply));
  }
}

@ChannelRole({
  name: "payout-approval-channel",
  description: "Approves payouts",
  approves: PayoutRequestDto,
  answeredBy: PauseAnswerer.Channel,
  replyInterpreter: PayoutReplyInterpreter,
})
export abstract class PayoutApprovalChannel extends ChannelOf<PayoutApprovalChannel> {}

@ChannelRole({
  name: "expense-approval-channel",
  description: "The thread's owner confirms an expense",
  approves: ExpenseRequestDto,
  answeredBy: PauseAnswerer.ThreadOwner,
  replyInterpreter: ExpenseReplyInterpreter,
})
export abstract class ExpenseApprovalChannel extends ChannelOf<ExpenseApprovalChannel> {}

@ChannelRole({
  name: "transfer-approval-channel",
  description: "Approves transfers (typed decisions only)",
  approves: TransferRequestDto,
  answeredBy: PauseAnswerer.Channel,
})
export abstract class TransferApprovalChannel extends ChannelOf<TransferApprovalChannel> {}

@Channel({ name: "desk-payout-approval-channel", description: "Asks the finance desk" })
export class DeskPayoutApprovalChannel extends PayoutApprovalChannel {
  send(ask: ChannelAsk<PayoutApprovalChannel>): Promise<ChannelOutcome<PayoutApprovalChannel>> {
    replyDesk.asks.push(ask);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@Channel({ name: "button-expense-approval-channel", description: "Shows the owner two buttons" })
export class ButtonExpenseApprovalChannel extends ExpenseApprovalChannel {
  send(ask: ChannelAsk<ExpenseApprovalChannel>): Promise<ChannelOutcome<ExpenseApprovalChannel>> {
    replyDesk.confirmations.push(ask);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@Channel({ name: "desk-transfer-approval-channel", description: "Asks the treasury desk" })
export class DeskTransferApprovalChannel extends TransferApprovalChannel {
  send(ask: ChannelAsk<TransferApprovalChannel>): Promise<ChannelOutcome<TransferApprovalChannel>> {
    replyDesk.transfers.push(ask);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@Tool({
  name: "pay_out",
  description: "Pays a payee",
  input: PayoutRequestDto,
  output: ReplyDeskDoneDto,
  channel: PayoutApprovalChannel,
})
export class PayOutTool implements ToolHandler<PayoutRequestDto, ReplyDeskDoneDto> {
  run(input: PayoutRequestDto): Promise<ReplyDeskDoneDto> {
    replyDesk.payouts.push(input);
    return Promise.resolve({ status: `paid ${input.payee} ${String(input.amountCents)}` });
  }
}

@Tool({
  name: "book_expense",
  description: "Books an expense",
  input: ExpenseRequestDto,
  output: ReplyDeskDoneDto,
  channel: ExpenseApprovalChannel,
})
export class BookExpenseTool implements ToolHandler<ExpenseRequestDto, ReplyDeskDoneDto> {
  run({ purpose }: ExpenseRequestDto): Promise<ReplyDeskDoneDto> {
    replyDesk.expenses.push(purpose);
    return Promise.resolve({ status: `booked ${purpose}` });
  }
}

@Tool({
  name: "transfer",
  description: "Transfers money",
  input: TransferRequestDto,
  output: ReplyDeskDoneDto,
  channel: TransferApprovalChannel,
})
export class TransferTool implements ToolHandler<TransferRequestDto, ReplyDeskDoneDto> {
  run({ account }: TransferRequestDto): Promise<ReplyDeskDoneDto> {
    return Promise.resolve({ status: `transferred to ${account}` });
  }
}

@Agent({
  name: "treasurer-agent",
  description: "Pays, books and transfers",
  prompt: "Do what is asked.",
  model: "test/treasurer",
  input: { message: WorkflowStartTextDto },
  tools: [PayOutTool, BookExpenseTool, TransferTool],
})
export class TreasurerAgent {}

@WorkflowStart({
  name: "treasury-workflow-start",
  description: "A request",
  input: WorkflowStartTextDto,
})
export class TreasuryWorkflowStart {}

@WorkflowFinish({
  name: "treasury-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class TreasuryWorkflowFinish {}

@Workflow({
  name: "treasury-workflow",
  version: "1.0.0",
  flow: [
    start(TreasuryWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAgent(TreasurerAgent)
      .toFinish(TreasuryWorkflowFinish),
  ],
  defaults: { tools: { maxToolCalls: 3 }, history: { limit: 2 } },
  providers: [ExpenseButtonCodes],
})
export class TreasuryWorkflow {}

/** The decisions' e-mail addresses are hidden from logs, traces and records. */
@PiiPolicy({
  name: "treasury-pii-policy",
  description: "Hides e-mail addresses",
  rules: [pii(PiiKind.Email, PiiAction.replaceWithKind())],
})
export class TreasuryPiiPolicy {}

const treasuryChannels = [
  DeskPayoutApprovalChannel,
  ButtonExpenseApprovalChannel,
  DeskTransferApprovalChannel,
  SeenTreasuryPausedExecutionRepository,
  SeenTreasuryCostLedgerRepository,
];

@Application({
  name: "treasury-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [TreasuryWorkflow],
  budgets: TEST_BUDGETS,
  providers: treasuryChannels,
  piiPolicies: [TreasuryPiiPolicy],
})
export class TreasuryApplication {}

/** The same, its resolved pause records kept five minutes only (#267 S107). */
@Application({
  name: "brief-treasury-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [TreasuryWorkflow],
  budgets: TEST_BUDGETS,
  providers: treasuryChannels,
  pauseRecordRetention: minutes(5),
})
export class BriefTreasuryApplication {}
