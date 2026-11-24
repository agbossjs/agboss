import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Action,
  Idempotency,
  InMemoryFencedEffectRepository,
  Injectable,
  OutboundRecovery,
  Reconciliation,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type ActionEndEvent,
  type ExecutionErrorEvent,
  type ExecutionRejectedEvent,
  type Tracked,
  Observer,
  Ttl,
} from "../../../src/index.js";
import { hours, seconds } from "../../../src/units/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { onStart } from "../../helpers/flow.js";
import { RecordingLogger } from "../../helpers/log.js";
import { IdempotencyKeyEnvironment } from "../../helpers/idempotency-key.environment.js";

/**
 * #538 acceptance — where a refused key could leak: an action that keys a fenced effect by the
 * text it is given (`Idempotency.runOnce`), one that sends a call under that
 * text (`Idempotency.sendOnce`), a listed `RecordingLogger`, and an observer of the hooks that carry
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
@Observer()
export class EchoObserver {
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

interface Message {
  readonly message: Tracked<WorkflowStartTextDto>;
}

@Action({
  name: "keyed-effect-action",
  description: "Writes one fenced effect keyed by the business key it is given",
  input: { message: WorkflowStartTextDto },
  output: WorkflowFinishTextDto,
  deps: [Idempotency],
})
export class KeyedEffectAction {
  constructor(private readonly idempotency: Idempotency) {}

  async execute(input: Message): Promise<WorkflowFinishTextDto> {
    // the key's text is what this fixture is about: its work is the same whatever the key (#825)
    await this.idempotency.runOnce({
      name: "charge",
      key: input.message.text,
      withoutFingerprint: true,
      ttl: hours(24),
      execute: () => {
        echoSeen.ran += 1;
        return { done: true };
      },
    });
    return { text: "charged" };
  }
}

@Action({
  name: "hand-keyed-send-action",
  description: "Sends one call under the business key it is given",
  input: { message: WorkflowStartTextDto },
  output: WorkflowFinishTextDto,
  deps: [Idempotency],
})
export class HandKeyedSendAction {
  constructor(private readonly idempotency: Idempotency) {}

  async execute(input: Message): Promise<WorkflowFinishTextDto> {
    await this.idempotency.sendOnce({
      name: "charge",
      key: input.message.text,
      target: "payments",
      operation: "charge",
      request: { amountUsd: 10 },
      timeout: seconds(15),
      ttl: hours(48),
      send: () => {
        echoSeen.ran += 1;
        return Promise.resolve({ receipt: "r1" });
      },
      recovery: OutboundRecovery.permanentLookup<never>(() => Reconciliation.notExecuted()),
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
  historyTtl: Ttl.Forever,
  flow: [onStart(KeyedEffectStart).toAction(KeyedEffectAction).toFinish(KeyedFinish)],
})
export class KeyedEffectWorkflow {}

@Workflow({
  name: "hand-keyed-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [onStart(HandKeyedStart).toAction(HandKeyedSendAction).toFinish(HandKeyedFinish)],
})
export class HandKeyedWorkflow {}

@Application({
  name: "key-echo-application",
  version: "1.0.0",
  environment: IdempotencyKeyEnvironment,
  workflows: [KeyedEffectWorkflow, HandKeyedWorkflow],
  providers: [InMemoryFencedEffectRepository, RecordingLogger],
  budgets: TEST_BUDGETS,
  observers: [EchoObserver],
})
export class KeyEchoApplication {}
