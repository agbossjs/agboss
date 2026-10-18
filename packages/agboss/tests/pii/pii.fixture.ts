/** The PII test application (#120): a support agent with an email tool, policies on every level. */
import {
  Agent,
  ExecutionContext,
  Injectable,
  PiiAction,
  PiiGroup,
  PiiKind,
  PiiPolicy,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  pii,
  secret,
  type PiiMatch,
  type PiiPolicyHandler,
  type PiiRefusal,
  type ToolHandler,
} from "../../src/index.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../src/dto/index.js";
import { Application } from "../../src/application/application.js";
import { EmptyEnvironment } from "../../src/environments/empty.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { start } from "../helpers/flow.js";

/** The variable the test key is read from. */
export const PII_KEY_VARIABLE = "PII_TEST_PSEUDONYM_KEY";

@PiiPolicy({
  name: "contact-pii-policy",
  description: "Hides contact details from models",
  rules: [
    pii(PiiKind.Email, PiiAction.replaceWithToken()),
    pii(PiiKind.Phone, PiiAction.replacePart({ keepLast: 2 })),
  ],
  pseudonymKey: secret(PII_KEY_VARIABLE),
})
export class ContactPiiPolicy {}

@PiiPolicy({
  name: "card-pii-policy",
  description: "Refuses card numbers",
  rules: [pii(PiiKind.CardNumber, PiiAction.blockWithRefusal())],
  pseudonymKey: secret(PII_KEY_VARIABLE),
})
export class CardPiiPolicy implements PiiRefusal {
  refusal(kind: PiiKind): string {
    return `Please do not send a ${kind}.`;
  }
}

@PiiPolicy({
  name: "government-pii-policy",
  description: "Hides government ids",
  rules: [pii(PiiGroup.Government, PiiAction.replaceWithKind())],
  pseudonymKey: secret(PII_KEY_VARIABLE),
})
export class GovernmentPiiPolicy {}

/** The employee ids a directory knows: a project's own detector (S61). */
@Injectable()
export class EmployeeDirectory {
  readonly ids = ["EMP-0042"];
}

@PiiPolicy({
  name: "employee-id-pii-policy",
  action: PiiAction.replaceWithKind(),
  deps: [EmployeeDirectory],
})
export class EmployeeIdPiiPolicy implements PiiPolicyHandler {
  constructor(private readonly directory: EmployeeDirectory) {}

  findMatches(text: string): readonly PiiMatch[] {
    return this.directory.ids.flatMap((id) => {
      const start = text.indexOf(id);
      return start < 0 ? [] : [{ start, end: start + id.length }];
    });
  }
}

/** What the email tool was called with, and what it adds to its result. */
@Injectable()
export class Outbox {
  readonly sent: string[] = [];
  note = "";
}

export class EmailSend {
  @Text({ prompt: "the address" })
  to!: string;

  @Text({ prompt: "the body" })
  body!: string;
}

export class EmailSent {
  @Text({ prompt: "what happened" })
  status!: string;

  @Text({ prompt: "the account", sensitive: PiiAction.replaceWithToken() })
  account!: string;
}

@Tool({
  name: "send_email",
  description: "Sends an email",
  input: EmailSend,
  output: EmailSent,
  deps: [Outbox, ExecutionContext],
})
export class SendEmail implements ToolHandler<EmailSend, EmailSent> {
  constructor(
    private readonly outbox: Outbox,
    private readonly executionContext: ExecutionContext,
  ) {}

  run({ to, body }: EmailSend): Promise<EmailSent> {
    this.executionContext.signal.throwIfAborted();
    this.outbox.sent.push(to);
    const status = `sent to ${to}: ${body}${this.outbox.note}`;
    return Promise.resolve({ status, account: "ACC-77" });
  }
}

const price = { inputPerMTok: 1, outputPerMTok: 10 };

@Agent({
  name: "support-agent",
  description: "Answers customers",
  prompt: "Answer the customer.",
  model: "test/support",
  price,
  tools: [SendEmail],
})
export class SupportAgent {}

@Agent({
  name: "open-agent",
  description: "Sees contact details",
  prompt: "Answer the customer.",
  model: "test/open",
  price,
  excludePiiPolicies: [ContactPiiPolicy],
})
export class OpenAgent {}

@WorkflowStart({
  name: "pii-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
export class PiiStart {}

@WorkflowFinish({
  name: "pii-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class PiiFinish {}

@WorkflowStart({
  name: "open-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
export class OpenStart {}

@WorkflowFinish({
  name: "open-workflow-finish",
  description: "The answer",
  output: WorkflowFinishTextDto,
})
export class OpenFinish {}

const defaults = { models: { temperature: 0 }, tools: { maxToolCalls: 3 } } as const;

@Workflow({
  name: "pii-workflow",
  version: "1.0.0",
  flow: [start(PiiStart).returns(WorkflowStartTextDto).toAgent(SupportAgent).toFinish(PiiFinish)],
  defaults,
  piiPolicies: [CardPiiPolicy, EmployeeIdPiiPolicy],
  providers: [Outbox, EmployeeDirectory],
})
export class PiiWorkflow {}

@Workflow({
  name: "open-workflow",
  version: "1.0.0",
  flow: [start(OpenStart).returns(WorkflowStartTextDto).toAgent(OpenAgent).toFinish(OpenFinish)],
  defaults,
})
export class OpenWorkflow {}

@Application({
  name: "pii-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [PiiWorkflow, OpenWorkflow],
  piiPolicies: [ContactPiiPolicy, GovernmentPiiPolicy],
  budgets: TEST_BUDGETS,
})
export class PiiApplication {}
