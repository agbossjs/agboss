import { Application } from "../../../src/application/application.js";
import { Channel } from "../../../src/components/decorators.js";
import { type ChannelAsk } from "../../../src/channels/channel-handler.js";
import { ChannelOutcome } from "../../../src/channels/channel-outcome.js";
import { Bool, Text } from "../../../src/dto/index.js";
import { Action } from "../../../src/flow/decorators/action.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { WorkflowFinish } from "../../../src/flow/decorators/workflow-finish.js";
import { WorkflowStart } from "../../../src/flow/decorators/workflow-start.js";
import type { InputOf, OutputOf } from "../../../src/flow/generated-types.js";
import type { ActionHandler } from "../../../src/flow/handlers.js";
import { EmptyEnvironment } from "../../../src/environments/empty.js";
import { PiiKind, PiiPolicy, ExternalTask } from "../../../src/index.js";
import { hours, days } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "./budgets.js";
import { onStart } from "./paths.js";
import { PauseRespondent } from "../../../src/pause/respondent.js";

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
  @Bool({ prompt: "whether the order goes on" })
  approved!: boolean;
}

export class ListDoneDto {
  @Text({ prompt: "what was decided" })
  status!: string;
}

/** The asks the channels were sent, in order. */
export const asked = { sent: [] as ChannelAsk<ListManagerExternalTask>[] };

export function resetAsked(): void {
  asked.sent.length = 0;
}

@ExternalTask({
  name: "list-manager-external-task",
  description: "A manager, within 24 hours",
  input: ListOrderDto,
  output: ListDecisionDto,
  respondent: PauseRespondent.Delegate,
  timeout: hours(24),
})
export class ListManagerExternalTask {}

@Channel({ name: "list-manager-channel", description: "Asks the manager", target: ListManagerExternalTask, ttl: days(1) })
export class ListManagerChannel {
  send(ask: ChannelAsk<ListManagerExternalTask>): Promise<ChannelOutcome<ListManagerExternalTask>> {
    asked.sent.push(ask);
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@ExternalTask({
  name: "list-owner-external-task",
  description: "The thread's owner, within 24 hours",
  input: ListOrderDto,
  output: ListDecisionDto,
  respondent: PauseRespondent.Owner,
  timeout: hours(24),
})
export class ListOwnerExternalTask {}

@Channel({ name: "list-owner-channel", description: "Waits for the owner", target: ListOwnerExternalTask, ttl: days(1) })
export class ListOwnerChannel {
  send(): Promise<ChannelOutcome<ListOwnerExternalTask>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@ExternalTask({
  name: "list-finance-external-task",
  description: "Finance, within 2 hours",
  input: ListOrderDto,
  output: ListDecisionDto,
  respondent: PauseRespondent.Delegate,
  timeout: hours(2),
})
export class ListFinanceExternalTask {}

@Channel({ name: "list-finance-channel", description: "Asks finance", target: ListFinanceExternalTask, ttl: days(1) })
export class ListFinanceChannel {
  send(): Promise<ChannelOutcome<ListFinanceExternalTask>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@ExternalTask({
  name: "list-open-external-task",
  description: "Anyone, no deadline",
  input: ListOrderDto,
  output: ListDecisionDto,
  respondent: PauseRespondent.Delegate,
  timeout: days(365),
})
export class ListOpenExternalTask {}

@Channel({ name: "list-open-channel", description: "Asks, no deadline", target: ListOpenExternalTask, ttl: days(1) })
export class ListOpenChannel {
  send(): Promise<ChannelOutcome<ListOpenExternalTask>> {
    return Promise.resolve(ChannelOutcome.awaitReply());
  }
}

@PiiPolicy({
  name: "list-email-pii-policy",
  description: "Hides emails everywhere (the application's)",
  rules: [PiiKind.Email.mask()],
})
export class ListEmailPiiPolicy {}

@PiiPolicy({
  name: "list-ssn-pii-policy",
  description: "Hides social security numbers in the manager's workflow only",
  rules: [PiiKind.UsSsn.mask()],
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
      status: `${order.orderId}: ${decision.approved ? "approved" : "refused"}`,
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
      .toExternalTask(ListManagerExternalTask)
      .toAction(RecordListedAction)
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
      .toExternalTask(ListOwnerExternalTask)
      .toAction(RecordListedAction)
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
      .toExternalTask(ListFinanceExternalTask)
      .toAction(RecordListedAction)
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
      .toExternalTask(ListOpenExternalTask)
      .toAction(RecordListedAction)
      .toFinish(ListWorkflowFinish),
  ],
})
export class ListOpenWorkflow {}

/** The workflows' starts, by who answers. */
export const managerFlow = { start: ListManagerWorkflowStart, role: "list-manager-external-task" };
export const ownerFlow = { start: ListOwnerWorkflowStart, role: "list-owner-external-task" };
export const financeFlow = { start: ListFinanceWorkflowStart, role: "list-finance-external-task" };
export const openFlow = { start: ListOpenWorkflowStart, role: "list-open-external-task" };

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
