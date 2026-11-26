/** An approved email (#120 tokens): the token map has to outlive a pause, a resume and a recovery. */
import {
  Agent,
  ExecutionContext,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  inline,
  Ttl,
} from "../../src/index.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { Application } from "../../src/application/application.js";
import {
  ApprovalDesk,
  ChatAppChannel,
  ChatAppToolApproval,
} from "../channels/approval.workflow.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { onStart } from "../helpers/flow.js";
import { SharedExecutionRecordRepository } from "../helpers/shared-infrastructure.js";
import { ContactPiiPolicy, EmailSend, EmailSent, Outbox } from "./pii.fixture.js";
import { TestModelProvider } from "../../src/testing/test-model-provider.js";

/** What the approved email tool received, across app instances (a recovery builds a new one). */
export const approvedRecipients: string[] = [];

@Tool({
  name: "send-approved-email-tool",
  description: "Sends an email once approved",
  input: EmailSend,
  output: EmailSent,
  approval: ChatAppToolApproval,
  deps: [Outbox, ExecutionContext],
})
export class SendApprovedEmail {
  constructor(
    private readonly outbox: Outbox,
    private readonly executionContext: ExecutionContext,
  ) {}

  execute({ to }: EmailSend): Promise<EmailSent> {
    this.executionContext.signal.throwIfAborted();
    this.outbox.sent.push(to);
    approvedRecipients.push(to);
    return Promise.resolve({ status: "sent", account: "ACC-1" });
  }
}

@Agent({
  name: "mailer-agent",
  description: "Sends approved emails",
  prompt: inline("Send the email."),
  model: "test/mailer",
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
  historyTtl: Ttl.Forever,
  flow: [onStart(MailStart).toAgent(MailerAgent).toFinish(MailFinish)],
  defaults: { models: { temperature: 0 }, tools: { maxToolCalls: 2 } },
  providers: [ApprovalDesk, Outbox],
})
export class MailWorkflow {}

@Application({
  name: "mail-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  workflows: [MailWorkflow],
  piiPolicies: [ContactPiiPolicy],
  channels: [ChatAppChannel],
  providers: [SharedExecutionRecordRepository],
  budgets: TEST_BUDGETS,
})
export class MailApplication {}
