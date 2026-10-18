import { TerminalUserChannel } from "../../../src/channels/terminal-channel.js";
import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Agent,
  Injectable,
  Tool,
  Workflow,
  WorkflowFinish,
  WorkflowSettings,
  WorkflowStart,
  type ExecutionErrorEvent,
  type ExecutionEvent,
  type ExecutionPauseEvent,
  type ExecutionRejectedEvent,
  type OnExecutionError,
  type OnExecutionPause,
  type OnExecutionRejected,
} from "../../../src/index.js";
import type { IncompatibleResume } from "../../../src/run/resume-guard.js";
import type { ToolHandler } from "../../../src/index.js";
import { start } from "../../helpers/flow.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import {
  SharedCheckpointSaver,
  SharedExecutionRecordRepository,
  SharedPausedExecutionRepository,
} from "../../helpers/shared-infrastructure.js";
import { EmptyEnvironment } from "../../../src/index.js";

/** Emails the tool really sent, in order (the tests reset it). */
export const sent: string[] = [];

/** What the migrating workflow's resume policy was asked (the tests reset it). */
export const asked: IncompatibleResume[] = [];

/** What the deployments' observer saw: pauses, errors and refused requests (the tests reset it). */
export const observed: {
  readonly hook: string;
  readonly state: { readonly runId?: string; readonly threadId?: string };
  readonly detail?: unknown;
}[] = [];

/** The execution an event is about: its id and thread. */
const idsOf = (event: ExecutionEvent): { readonly runId: string; readonly threadId: string } => ({
  runId: event.executionId,
  threadId: event.threadId,
});

@Injectable()
export class MailLog implements OnExecutionPause, OnExecutionError, OnExecutionRejected {
  onExecutionPause(event: ExecutionPauseEvent): void {
    observed.push({ hook: "pause", state: idsOf(event) });
  }
  onExecutionError(event: ExecutionErrorEvent): void {
    observed.push({ hook: "error", state: idsOf(event), detail: event.error });
  }
  onExecutionRejected(event: ExecutionRejectedEvent): void {
    const state = event.threadId === undefined ? {} : { threadId: event.threadId };
    observed.push({ hook: "rejected", state, detail: event });
  }
}

export class Email {
  @Text({ prompt: "the recipient" })
  to!: string;
}

export class Sent {
  @Text()
  status!: string;
}

/** A write tool: it waits for an approval, so a run pauses before it. */
@Tool({
  name: "send_email",
  description: "Sends an email",
  channel: TerminalUserChannel,
  input: Email,
  output: Sent,
})
export class SendEmail implements ToolHandler<Email, Sent> {
  run({ to }: Email): Promise<Sent> {
    sent.push(to);
    return Promise.resolve({ status: `sent to ${to}` });
  }
}

@Agent({
  name: "mailer-agent",
  description: "Sends the emails it is asked to",
  prompt: "Send the email you are asked to send.",
  tools: [SendEmail],
  model: "test/mailer",
})
export class Mailer {}

@WorkflowStart({
  name: "start-workflow-start",
  description: "A request",
  input: WorkflowStartTextDto,
})
export class Start {}

@WorkflowFinish({
  name: "finish-workflow-finish",
  description: "The reply",
  output: WorkflowFinishTextDto,
})
export class Finish {}

const workflow = {
  name: "mail-workflow",
  defaults: {
    models: { maxTokens: 100, temperature: 0 },
    history: { limit: 1 },
    tools: { maxToolCalls: 2 },
  },
  channelClasses: [TerminalUserChannel],
  flow: [
    start(Start)
      .returns(WorkflowStartTextDto)
      .toAgent(Mailer)
      .toFinish(Finish),
  ],
};

/** The first deployment. */
@Workflow({ ...workflow, version: "1.0.0" })
export class MailV1 {}

/** The next deployment: another version, so another config hash; no resume policy. */
@Workflow({ ...workflow, version: "2.0.0" })
export class MailV2 {}

/** The next deployment, declaring that runs paused under 1.0.0 may continue on it. */
@Workflow({ ...workflow, version: "2.0.0" })
export class MailV2Migrating {
  settings(): WorkflowSettings {
    return WorkflowSettings.builder()
      .onIncompatibleResume((resume) => {
        asked.push(resume);
        return resume.paused.workflowVersion === "1.0.0" ? "resume" : "reject";
      })
      .build();
  }
}

/** What every deployment runs on: a durable database shared by the app instances of a test. */
const durable = [
  SharedCheckpointSaver,
  SharedPausedExecutionRepository,
  SharedExecutionRecordRepository,
];

@Application({
  name: "mail-v1-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [MailV1],
  providers: durable,
  budgets: TEST_BUDGETS,
  observers: [MailLog],
})
export class MailV1Application {}

@Application({
  name: "mail-v2-application",
  version: "2.0.0",
  environment: EmptyEnvironment,
  workflows: [MailV2],
  providers: durable,
  budgets: TEST_BUDGETS,
  observers: [MailLog],
})
export class MailV2Application {}

@Application({
  name: "mail-v2-migrating-application",
  version: "2.0.0",
  environment: EmptyEnvironment,
  workflows: [MailV2Migrating],
  providers: durable,
  budgets: TEST_BUDGETS,
  observers: [MailLog],
})
export class MailV2MigratingApplication {}

/** The first deployment with the built-in in-memory paused executions (checkpoints still shared). */
@Application({
  name: "mail-v1-memory-pauses-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [MailV1],
  providers: [SharedCheckpointSaver, SharedExecutionRecordRepository],
  budgets: TEST_BUDGETS,
  observers: [MailLog],
})
export class MailV1MemoryPausesApplication {}

/** The first deployment on the built-in in-memory infrastructure (one app instance per test). */
@Application({
  name: "mail-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [MailV1],
  budgets: TEST_BUDGETS,
  observers: [MailLog],
})
export class MailApplication {}
