import { Application } from "../../../src/application/application.js";
import { Channel } from "../../../src/components/decorators.js";
import { ChannelOf, type ChannelAsk } from "../../../src/channels/channel-handler.js";
import { ChannelOutcome } from "../../../src/channels/channel-outcome.js";
import { ChannelRole, PauseAnswerer } from "../../../src/channels/channel-role.decorator.js";
import { Flag, Text } from "../../../src/dto/index.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import type { InputOf, OutputOf } from "../../../src/flow/generated-types.js";
import type { ActionHandler } from "../../../src/flow/handlers.js";
import { EmptyEnvironment } from "../../../src/environments/empty.js";
import { PiiAction, PiiKind, PiiPolicy, pii } from "../../../src/index.js";
import { hours } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "./budgets.js";
import { onStart } from "./paths.js";

/**
 * #943 — pauses to list: a manager's approval (24 h, a channel pause, its workflow masks social
 * security numbers on top of the application's emails), the same asked of the thread's owner (24 h),
 * a finance question (2 h), and one with no deadline. What the channels were sent is in `asked`,
 * reset per test.
 */

export class ListOrderDto {
  @Text({ prompt: "the order" })
  orderId!: string;

  @Text({ prompt: "free text of the order, with whatever the customer wrote" })
  note!: string;
}

export class ListDecisionDto {
  @Flag({ prompt: "whether the order goes on" })
  approved!: boolean;
}

export class ListDoneDto {
  @Text({ prompt: "what was decided" })
  status!: string;
}

/** The asks the channels were sent, in order. */
export const asked = { sent: [] as ChannelAsk<ListManagerQuestion>[] };

export function resetAsked(): void {
  asked.sent.length = 0;
}

@ChannelRole({
  name: "list-manager-question",
  description: "A manager, within 24 hours",
  ask: ListOrderDto,
  answer: ListDecisionDto,
  answerer: PauseAnswerer.Channel,
  expiresIn: hours(24),
})
export abstract class ListManagerQuestion extends ChannelOf<ListManagerQuestion> {}

@Channel({ name: "list-manager-channel", description: "Asks the manager" })
export class ListManagerChannel extends ListManagerQuestion {
  send(ask: ChannelAsk<ListManagerQuestion>): Promise<ChannelOutcome<ListManagerQuestion>> {
    asked.sent.push(ask);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@ChannelRole({
  name: "list-owner-question",
  description: "The thread's owner, within 24 hours",
  ask: ListOrderDto,
  answer: ListDecisionDto,
  answerer: PauseAnswerer.ThreadOwner,
  expiresIn: hours(24),
})
export abstract class ListOwnerQuestion extends ChannelOf<ListOwnerQuestion> {}

@Channel({ name: "list-owner-channel", description: "Waits for the owner" })
export class ListOwnerChannel extends ListOwnerQuestion {
  send(): Promise<ChannelOutcome<ListOwnerQuestion>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@ChannelRole({
  name: "list-finance-question",
  description: "Finance, within 2 hours",
  ask: ListOrderDto,
  answer: ListDecisionDto,
  answerer: PauseAnswerer.Channel,
  expiresIn: hours(2),
})
export abstract class ListFinanceQuestion extends ChannelOf<ListFinanceQuestion> {}

@Channel({ name: "list-finance-channel", description: "Asks finance" })
export class ListFinanceChannel extends ListFinanceQuestion {
  send(): Promise<ChannelOutcome<ListFinanceQuestion>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@ChannelRole({
  name: "list-open-question",
  description: "Anyone, no deadline",
  ask: ListOrderDto,
  answer: ListDecisionDto,
  answerer: PauseAnswerer.Channel,
})
export abstract class ListOpenQuestion extends ChannelOf<ListOpenQuestion> {}

@Channel({ name: "list-open-channel", description: "Asks, no deadline" })
export class ListOpenChannel extends ListOpenQuestion {
  send(): Promise<ChannelOutcome<ListOpenQuestion>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@PiiPolicy({
  name: "list-email-pii-policy",
  description: "Hides emails everywhere (the application's)",
  rules: [pii(PiiKind.Email, PiiAction.replaceWithKind())],
})
export class ListEmailPiiPolicy {}

@PiiPolicy({
  name: "list-ssn-pii-policy",
  description: "Hides social security numbers in the manager's workflow only",
  rules: [pii(PiiKind.UsSsn, PiiAction.replaceWithKind())],
})
export class ListSsnPiiPolicy {}

@WorkflowFinish({ name: "list-workflow-finish", description: "Done", output: ListDoneDto })
export class ListWorkflowFinish {}

@Action({
  name: "record-listed-action",
  description: "Records the decision",
  input: { order: ListOrderDto, decision: ListDecisionDto },
  output: ListDoneDto,
})
export class RecordListedAction implements ActionHandler<RecordListedAction> {
  execute({ order, decision }: InputOf<RecordListedAction>): Promise<OutputOf<RecordListedAction>> {
    return Promise.resolve({
      status: `${order.value.orderId}: ${decision.value.approved ? "approved" : "refused"}`,
    });
  }
}

@WorkflowStart({
  name: "list-manager-workflow-start",
  description: "An order",
  input: ListOrderDto,
})
export class ListManagerWorkflowStart {}

@Workflow({
  name: "list-manager-workflow",
  version: "1.0.0",
  flow: [
    onStart(ListManagerWorkflowStart)
      .returns(ListOrderDto)
      .toExternalTask(ListManagerQuestion)
      .returns(ListDecisionDto)
      .toAction(RecordListedAction)
      .returns(ListDoneDto)
      .toFinish(ListWorkflowFinish),
  ],
  piiPolicies: [ListSsnPiiPolicy],
})
export class ListManagerWorkflow {}

@WorkflowStart({ name: "list-owner-workflow-start", description: "An order", input: ListOrderDto })
export class ListOwnerWorkflowStart {}

@Workflow({
  name: "list-owner-workflow",
  version: "1.0.0",
  flow: [
    onStart(ListOwnerWorkflowStart)
      .returns(ListOrderDto)
      .toExternalTask(ListOwnerQuestion)
      .returns(ListDecisionDto)
      .toAction(RecordListedAction)
      .returns(ListDoneDto)
      .toFinish(ListWorkflowFinish),
  ],
})
export class ListOwnerWorkflow {}

@WorkflowStart({
  name: "list-finance-workflow-start",
  description: "An order",
  input: ListOrderDto,
})
export class ListFinanceWorkflowStart {}

@Workflow({
  name: "list-finance-workflow",
  version: "1.0.0",
  flow: [
    onStart(ListFinanceWorkflowStart)
      .returns(ListOrderDto)
      .toExternalTask(ListFinanceQuestion)
      .returns(ListDecisionDto)
      .toAction(RecordListedAction)
      .returns(ListDoneDto)
      .toFinish(ListWorkflowFinish),
  ],
})
export class ListFinanceWorkflow {}

@WorkflowStart({ name: "list-open-workflow-start", description: "An order", input: ListOrderDto })
export class ListOpenWorkflowStart {}

@Workflow({
  name: "list-open-workflow",
  version: "1.0.0",
  flow: [
    onStart(ListOpenWorkflowStart)
      .returns(ListOrderDto)
      .toExternalTask(ListOpenQuestion)
      .returns(ListDecisionDto)
      .toAction(RecordListedAction)
      .returns(ListDoneDto)
      .toFinish(ListWorkflowFinish),
  ],
})
export class ListOpenWorkflow {}

/** The workflows' starts, by who answers. */
export const managerFlow = { start: ListManagerWorkflowStart, role: "list-manager-question" };
export const ownerFlow = { start: ListOwnerWorkflowStart, role: "list-owner-question" };
export const financeFlow = { start: ListFinanceWorkflowStart, role: "list-finance-question" };
export const openFlow = { start: ListOpenWorkflowStart, role: "list-open-question" };

@Application({
  name: "listing-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ListManagerWorkflow, ListOwnerWorkflow, ListFinanceWorkflow, ListOpenWorkflow],
  budgets: TEST_BUDGETS,
  providers: [ListManagerChannel, ListOwnerChannel, ListFinanceChannel, ListOpenChannel],
  piiPolicies: [ListEmailPiiPolicy],
})
export class ListingApplication {}
