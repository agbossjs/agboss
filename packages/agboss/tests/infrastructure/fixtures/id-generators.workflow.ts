import { randomUUID } from "node:crypto";
import { WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  ApplicationContext,
  EmptyEnvironment,
  IdGenerator,
  Injectable,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";
import { SingleChildWorkflow } from "../../channels/fixtures/child-pauses.workflow.js";
import {
  CustomerOrderConfirmationChannel,
  FinanceDeskRefundApprovalChannel,
  PauseLog,
  SeenPausedExecutionRepository,
} from "../../channels/fixtures/pauses.workflow.js";

/**
 * #313 — a project's own ids: `IdGenerator` replaced by listing a subclass in
 * `@Application({ providers })`, like `Clock` (the spec's example, S1).
 */
@Injectable()
export class PrefixedIdGenerator extends IdGenerator {
  override newThreadId(): string {
    return `thr_${randomUUID()}`;
  }

  override newExecutionId(): string {
    return `exe_${randomUUID()}`;
  }
}

/** A second generator: listed with the first, the contract is ambiguous. */
@Injectable()
export class OtherIdGenerator extends IdGenerator {
  override newThreadId(): string {
    return "other-thread";
  }

  override newExecutionId(): string {
    return "other-execution";
  }
}

/** A generator that reads the contexts: it is created before them. */
@Injectable({ deps: [ApplicationContext] })
export class InstanceIdGenerator extends IdGenerator {
  constructor(private readonly applicationContext: ApplicationContext) {
    super();
  }

  override newThreadId(): string {
    return `${this.applicationContext.instanceId}-thread`;
  }

  override newExecutionId(): string {
    return `${this.applicationContext.instanceId}-execution`;
  }
}

/** The channels the single-child workflow's agent pauses on. */
const CHANNELS = [
  FinanceDeskRefundApprovalChannel,
  CustomerOrderConfirmationChannel,
  SeenPausedExecutionRepository,
];

/** The child-pauses workflow (a root, a child and a pause) on the project's ids. */
@Application({
  name: "prefixed-ids-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [SingleChildWorkflow],
  providers: [PrefixedIdGenerator, ...CHANNELS],
  observers: [PauseLog],
  budgets: TEST_BUDGETS,
})
export class PrefixedIdsApplication {}

/** The same workflow on the built-in ids. */
@Application({
  name: "built-in-ids-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [SingleChildWorkflow],
  providers: CHANNELS,
  observers: [PauseLog],
  budgets: TEST_BUDGETS,
})
export class BuiltInIdsApplication {}

/** Two generators listed: `[di.ambiguous-implementation]`. */
@Application({
  name: "two-generators-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [SingleChildWorkflow],
  providers: [PrefixedIdGenerator, OtherIdGenerator, ...CHANNELS],
  budgets: TEST_BUDGETS,
})
export class TwoGeneratorsApplication {}

/** A generator that injects `ApplicationContext`: the start fails, naming why. */
@Application({
  name: "context-generator-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [SingleChildWorkflow],
  providers: [InstanceIdGenerator, ...CHANNELS],
  budgets: TEST_BUDGETS,
})
export class ContextGeneratorApplication {}

@WorkflowStart({
  name: "echo-workflow-start",
  description: "A message",
  input: WorkflowStartTextDto,
})
export class EchoWorkflowStart {}

@WorkflowFinish({
  name: "echo-workflow-finish",
  description: "The message, as is",
  output: WorkflowStartTextDto,
})
export class EchoWorkflowFinish {}

/** A generator in a workflow's providers: `[di.infrastructure-in-workflow]`. */
@Workflow({
  name: "echo-workflow",
  version: "1.0.0",
  flow: [
    start(EchoWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toFinish(EchoWorkflowFinish),
  ],
  providers: [PrefixedIdGenerator],
})
export class EchoWorkflow {}

@Application({
  name: "generator-in-workflow-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [EchoWorkflow],
  budgets: TEST_BUDGETS,
})
export class GeneratorInWorkflowApplication {}
