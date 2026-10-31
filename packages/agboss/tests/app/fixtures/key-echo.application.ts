import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Action,
  EmptyEnvironment,
  ExecutionContext,
  InMemoryFencedEffectRepository,
  Injectable,
  OutboundCalls,
  OutboundCallReconciliation,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  fencedEffectKeyOf,
  type ActionEndEvent,
  type ExecutionErrorEvent,
  type ExecutionRejectedEvent,
  type OnActionEnd,
  type OnExecutionError,
  type OnExecutionRejected,
  type Produced,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";
import { RecordingLogger } from "../../helpers/log.js";

/**
 * #538 acceptance — where a refused key could leak: an action that keys a fenced effect by the
 * text it is given (`fencedEffectKeyOf`), one that sends a call under a key built by hand with that
 * text (`OutboundCalls.send`), a listed `RecordingLogger`, and an observer of the hooks that carry
 * an error or a refused request.
 */

/** Every event the observer saw, and how many effects and sends ran. */
export const echoSeen = {
  events: [] as unknown[],
  ran: 0,
};

export function resetEchoSeen(): void {
  echoSeen.events.length = 0;
  echoSeen.ran = 0;
}

/** Keeps every refusal, error and action end. */
@Injectable()
export class EchoObserver implements OnExecutionRejected, OnExecutionError, OnActionEnd {
  onExecutionRejected(event: ExecutionRejectedEvent): void {
    echoSeen.events.push(event);
  }
  onExecutionError(event: ExecutionErrorEvent): void {
    echoSeen.events.push(event);
  }
  onActionEnd(event: ActionEndEvent): void {
    echoSeen.events.push(event);
  }
}

type Message = { readonly message: Produced<WorkflowStartTextDto, unknown> };

@Action({
  name: "keyed-effect-action",
  description: "Writes one fenced effect keyed by the business key it is given",
  input: { message: WorkflowStartTextDto },
  output: WorkflowFinishTextDto,
  deps: [ExecutionContext, InMemoryFencedEffectRepository],
})
export class KeyedEffectAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly fencedEffects: InMemoryFencedEffectRepository,
  ) {}

  async execute(input: Message): Promise<WorkflowFinishTextDto> {
    const key = fencedEffectKeyOf(this.executionContext, "charge", {
      businessKey: input.message.value.text,
    });
    await this.fencedEffects.saveResultIfAbsent(key, () => {
      echoSeen.ran += 1;
      return { done: true };
    });
    return { text: "charged" };
  }
}

@Action({
  name: "hand-keyed-send-action",
  description: "Sends one call under a key built by hand with the business key it is given",
  input: { message: WorkflowStartTextDto },
  output: WorkflowFinishTextDto,
  deps: [ExecutionContext, OutboundCalls],
})
export class HandKeyedSendAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly outboundCalls: OutboundCalls,
  ) {}

  async execute(input: Message): Promise<WorkflowFinishTextDto> {
    const valid = fencedEffectKeyOf(this.executionContext, "charge", { businessKey: "order:1" });
    const byHand = { ...valid, businessKey: input.message.value.text };
    await this.outboundCalls.send(byHand, {
      target: "payments",
      operation: "charge",
      request: { amountUsd: 10 },
      send: () => {
        echoSeen.ran += 1;
        return Promise.resolve({ receipt: "r1" });
      },
      reconcile: () => Promise.resolve(OutboundCallReconciliation.notSent()),
    });
    return { text: "sent" };
  }
}

@WorkflowStart({
  name: "keyed-effect-workflow-start",
  description: "A key",
  input: WorkflowStartTextDto,
})
export class KeyedEffectStart {}

@WorkflowStart({
  name: "hand-keyed-workflow-start",
  description: "A key",
  input: WorkflowStartTextDto,
})
export class HandKeyedStart {}

@WorkflowFinish({
  name: "keyed-workflow-finish",
  description: "Done",
  output: WorkflowFinishTextDto,
})
export class KeyedFinish {}

@WorkflowFinish({
  name: "hand-keyed-workflow-finish",
  description: "Done",
  output: WorkflowFinishTextDto,
})
export class HandKeyedFinish {}

@Workflow({
  name: "keyed-effect-workflow",
  version: "1.0.0",
  flow: [
    start(KeyedEffectStart)
      .returns(WorkflowStartTextDto)
      .toAction(KeyedEffectAction)
      .returns(WorkflowFinishTextDto)
      .toFinish(KeyedFinish),
  ],
})
export class KeyedEffectWorkflow {}

@Workflow({
  name: "hand-keyed-workflow",
  version: "1.0.0",
  flow: [
    start(HandKeyedStart)
      .returns(WorkflowStartTextDto)
      .toAction(HandKeyedSendAction)
      .returns(WorkflowFinishTextDto)
      .toFinish(HandKeyedFinish),
  ],
})
export class HandKeyedWorkflow {}

@Application({
  name: "key-echo-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [KeyedEffectWorkflow, HandKeyedWorkflow],
  providers: [InMemoryFencedEffectRepository, RecordingLogger],
  budgets: TEST_BUDGETS,
  observers: [EchoObserver],
})
export class KeyEchoApplication {}
