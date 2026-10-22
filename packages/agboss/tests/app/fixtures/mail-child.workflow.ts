import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Agent,
  EmptyEnvironment,
  ExecutionContext,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowSettings,
  WorkflowStart,
  type ToolHandler,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";
import { RecordingLogger } from "../../helpers/log.js";
import {
  SharedCheckpointSaver,
  SharedExecutionRecordRepository,
  SharedPausedExecutionRepository,
} from "../../helpers/shared-infrastructure.js";
import { asked, MailLog, SendEmail } from "./mail.workflow.js";

/**
 * #336 AC2 — a rolling deploy of a child workflow: the parent `mail-parent-workflow` stays 1.0.0,
 * its child `mail-child-workflow` goes 1.0.0 → 2.0.0 with another prompt for its agent. A run
 * paused (or interrupted) inside the child on the first deployment is then incompatible with the
 * second: the root's `configHash` covers its children.
 */

/** The holds the hold tool started (the tests reset it): only the first one waits. */
export const holds: AbortSignal[] = [];

export class HoldQuery {
  @Text({ prompt: "what to wait for" })
  text!: string;
}

/** The first call waits until its execution is stopped; later ones return at once. */
@Tool({
  name: "mail-hold-tool",
  description: "Waits",
  input: HoldQuery,
  output: HoldQuery,
  deps: [ExecutionContext],
})
export class MailHold implements ToolHandler<HoldQuery, HoldQuery> {
  constructor(private readonly executionContext: ExecutionContext) {}

  run(input: HoldQuery): Promise<HoldQuery> {
    const { signal } = this.executionContext;
    holds.push(signal);
    if (holds.length > 1) return Promise.resolve(input);
    return new Promise((resolve) => {
      signal.addEventListener("abort", () => {
        resolve(input);
      });
    });
  }
}

@Agent({
  name: "mailer-agent",
  description: "Sends the emails it is asked to",
  prompt: "Send the email you are asked to send.",
  tools: [MailHold, SendEmail],
  model: "test/mailer",
})
export class ChildMailerV1 {}

/** The second deployment's agent: the same name, another prompt. */
@Agent({
  name: "mailer-agent",
  description: "Sends the emails it is asked to",
  prompt: "Send the email you are asked to send, and sign it.",
  tools: [MailHold, SendEmail],
  model: "test/mailer",
})
export class ChildMailerV2 {}

@WorkflowStart({
  name: "mail-child-workflow-start",
  description: "The email to send",
  input: WorkflowStartTextDto,
})
export class MailChildStart {}

@WorkflowFinish({
  name: "mail-child-workflow-finish",
  description: "What was sent",
  output: WorkflowFinishTextDto,
})
export class MailChildFinish {}

@WorkflowStart({
  name: "mail-parent-workflow-start",
  description: "A request",
  input: WorkflowStartTextDto,
})
export class MailParentStart {}

@WorkflowFinish({
  name: "mail-parent-workflow-finish",
  description: "The reply",
  output: WorkflowFinishTextDto,
})
export class MailParentFinish {}

const child = { name: "mail-child-workflow", defaults: { tools: { maxToolCalls: 3 } } };

@Workflow({
  ...child,
  version: "1.0.0",
  flow: [
    start(MailChildStart)
      .returns(WorkflowStartTextDto)
      .toAgent(ChildMailerV1)
      .toFinish(MailChildFinish),
  ],
})
export class MailChildV1 {}

@Workflow({
  ...child,
  version: "2.0.0",
  flow: [
    start(MailChildStart)
      .returns(WorkflowStartTextDto)
      .toAgent(ChildMailerV2)
      .toFinish(MailChildFinish),
  ],
})
export class MailChildV2 {}

/** The parent of the first deployment. */
@Workflow({
  name: "mail-parent-workflow",
  version: "1.0.0",
  flow: [
    start(MailParentStart)
      .returns(WorkflowStartTextDto)
      .toWorkflow(MailChildV1)
      .returns(WorkflowFinishTextDto)
      .toFinish(MailParentFinish),
  ],
})
export class MailParentV1 {}

/** The same parent on the second deployment: only its child changed. */
@Workflow({
  name: "mail-parent-workflow",
  version: "1.0.0",
  flow: [
    start(MailParentStart)
      .returns(WorkflowStartTextDto)
      .toWorkflow(MailChildV2)
      .returns(WorkflowFinishTextDto)
      .toFinish(MailParentFinish),
  ],
})
export class MailParentV2 {}

/** The second deployment's parent, declaring that runs paused under the old child may continue. */
@Workflow({
  name: "mail-parent-workflow",
  version: "1.0.0",
  flow: [
    start(MailParentStart)
      .returns(WorkflowStartTextDto)
      .toWorkflow(MailChildV2)
      .returns(WorkflowFinishTextDto)
      .toFinish(MailParentFinish),
  ],
})
export class MailParentV2Migrating {
  settings(): WorkflowSettings {
    return WorkflowSettings.builder()
      .onIncompatibleResume((resume) => {
        asked.push(resume);
        return "resume";
      })
      .build();
  }
}

/** What every deployment runs on: a durable database shared by the app instances of a test. */
const durable = [
  SharedCheckpointSaver,
  SharedPausedExecutionRepository,
  SharedExecutionRecordRepository,
  RecordingLogger,
];

const deployment = {
  environment: EmptyEnvironment,
  providers: durable,
  budgets: TEST_BUDGETS,
  observers: [MailLog],
};

@Application({
  ...deployment,
  name: "mail-parent-application",
  version: "1.0.0",
  workflows: [MailParentV1],
})
export class MailParentV1Application {}

@Application({
  ...deployment,
  name: "mail-parent-application",
  version: "2.0.0",
  workflows: [MailParentV2],
})
export class MailParentV2Application {}

@Application({
  ...deployment,
  name: "mail-parent-application",
  version: "2.0.0",
  workflows: [MailParentV2Migrating],
})
export class MailParentV2MigratingApplication {}
