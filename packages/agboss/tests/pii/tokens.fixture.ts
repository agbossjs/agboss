/** An approved email (#120 tokens): the token map has to outlive a pause, a resume and a recovery. */
import {
  Agent,
  ExecutionContext,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ToolHandler,
} from "../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { Application } from "../../src/application/application.js";
import { EmptyEnvironment } from "../../src/environments/empty.js";
import { ApprovalDesk, ChatAppChannel } from "../channels/approval.workflow.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { start } from "../helpers/flow.js";
import { SharedExecutionRecordRepository } from "../helpers/shared-infrastructure.js";
import { ContactPiiPolicy, EmailSend, EmailSent, Outbox } from "./pii.fixture.js";

/** What the approved email tool received, across app instances (a recovery builds a new one). */
export const approvedRecipients: string[] = [];

@Tool({
  name: "send_approved_email",
  description: "Sends an email once approved",
  input: EmailSend,
  output: EmailSent,
  channel: ChatAppChannel,
  deps: [Outbox, ExecutionContext],
})
export class SendApprovedEmail implements ToolHandler<EmailSend, EmailSent> {
  constructor(
    private readonly outbox: Outbox,
    private readonly executionContext: ExecutionContext,
  ) {}

  run({ to }: EmailSend): Promise<EmailSent> {
    this.executionContext.signal.throwIfAborted();
    this.outbox.sent.push(to);
    approvedRecipients.push(to);
    return Promise.resolve({ status: "sent", account: "ACC-1" });
  }
}

@Agent({
  name: "mailer-agent",
  description: "Sends approved emails",
  prompt: "Send the email.",
  model: "test/mailer",
  price: { inputPerMTok: 1, outputPerMTok: 10 },
  tools: [SendApprovedEmail],
})
export class MailerAgent {}

@WorkflowStart({
  name: "mail-workflow-start",
  description: "A request",
  input: WorkflowStartTextDto,
})
export class MailStart {}

@WorkflowFinish({
  name: "mail-workflow-finish",
  description: "Done",
  output: WorkflowFinishTextDto,
})
export class MailFinish {}

@Workflow({
  name: "mail-workflow",
  version: "1.0.0",
  flow: [start(MailStart).returns(WorkflowStartTextDto).toAgent(MailerAgent).toFinish(MailFinish)],
  defaults: { models: { temperature: 0 }, tools: { maxToolCalls: 2 } },
  providers: [ApprovalDesk, Outbox],
})
export class MailWorkflow {}

@Application({
  name: "mail-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [MailWorkflow],
  piiPolicies: [ContactPiiPolicy],
  providers: [SharedExecutionRecordRepository],
  budgets: TEST_BUDGETS,
})
export class MailApplication {}
