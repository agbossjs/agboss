import { Text, WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Action,
  Agent,
  EmptyEnvironment,
  StepFailedError,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Tracked,
  inline,
  Ttl,
} from "../../../src/index.js";
import { Injectable } from "../../../src/components/decorators.js";
import { Application } from "../../../src/application/application.js";
import {
  ModelCost,
  ModelFailure,
  ModelProvider,
  OpenAiCompatibleDriver,
  PromptCaching,
  Reasoning,
  RetryPolicy,
} from "../../../src/models/index.js";
import { minutes, seconds, usd } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { onStart, toAction } from "../../helpers/flow.js";
import { CircuitBreakerPolicy } from "../../../src/models/circuit-breaker-policy.js";

/**
 * #396 PR 6 — what chaos exercises: a reservation (undone by its release, #340), then an agent on a
 * real HTTP provider whose failure takes the `.onError` side path through the undo. Two
 * applications: one whose provider retries a 429 and a timeout, one whose provider retries nothing.
 */

export class ReservationDto {
  @Text({ prompt: "the reservation's id" })
  reservationId!: string;
}

/** The desk the actions call: the tests read what was reserved and released. */
@Injectable()
export class ChaosDesk {
  readonly released: string[] = [];

  release(id: string): void {
    this.released.push(id);
  }
}

@Action({
  name: "release-action",
  description: "Releases the reservation",
  input: { reservation: ReservationDto },
  deps: [ChaosDesk],
})
export class ReleaseAction {
  constructor(private readonly chaosDesk: ChaosDesk) {}

  execute(input: { readonly reservation: Tracked<ReservationDto> }): Promise<void> {
    this.chaosDesk.release(input.reservation.reservationId);
    return Promise.resolve();
  }
}

@Action({
  name: "reserve-action",
  description: "Reserves a seat",
  output: ReservationDto,
  compensateWith: ReleaseAction,
})
export class ReserveAction {
  execute(): Promise<ReservationDto> {
    return Promise.resolve({ reservationId: "seat-1" });
  }
}

@Agent({
  name: "confirm-agent",
  description: "Confirms the reservation",
  prompt: inline("Confirm the reservation."),
  model: "chaos/model",
  input: { message: WorkflowStartTextDto },
})
export class ConfirmAgent {}

@WorkflowStart({
  name: "chaos-workflow-start",
  description: "A request",
  input: WorkflowStartTextDto,
})
export class ChaosWorkflowStart {}

@WorkflowFinish({
  name: "confirmed-workflow-finish",
  description: "Confirmed",
  output: WorkflowFinishTextDto,
})
export class ConfirmedWorkflowFinish {}

@WorkflowFinish({
  name: "released-workflow-finish",
  description: "The reservation, released",
  output: ReservationDto,
})
export class ReleasedWorkflowFinish {}

@Workflow({
  name: "chaos-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(ChaosWorkflowStart)
      .toAction(ReserveAction)
      .toAgent(ConfirmAgent)
      .onError(
        StepFailedError,
        toAction(ReleaseAction)
          .toFinish(ReleasedWorkflowFinish),
      )
      .toFinish(ConfirmedWorkflowFinish),
  ],
  providers: [ChaosDesk],
})
export class ChaosWorkflow {}

const PROVIDER = {
  driver: OpenAiCompatibleDriver({ baseUrl: "http://chaos.test/v1" }),
  timeout: seconds(5),
  cost: ModelCost.fromPrices({
    "chaos/model": { inputPerMillion: usd(1), outputPerMillion: usd(1) },
  }),
  reasoning: Reasoning.off(),
  promptCaching: PromptCaching.off(),
  circuitBreakerPolicy: CircuitBreakerPolicy.fixed({
    failureThreshold: 50,
    failureWindow: minutes(1),
    openDuration: seconds(30),
  }),
} as const;

/** Retries a 429 and a timeout, a moment apart. */
@ModelProvider({
  ...PROVIDER,
  name: "retrying-model-provider",
  description: "Retries what chaos injects",
  retryPolicy: RetryPolicy.fixed({
    maxAttempts: 3,
    delay: seconds(0.01),
    retryOn: [ModelFailure.RateLimited, ModelFailure.Timeout],
  }),
})
export class RetryingModelProvider {}

/** Retries nothing: a failure is the step's. */
@ModelProvider({
  ...PROVIDER,
  name: "fragile-model-provider",
  description: "Retries nothing",
})
export class FragileModelProvider {}

@Application({
  name: "retrying-chaos-application",
  modelProvider: RetryingModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ChaosWorkflow],
  providers: [RetryingModelProvider],
  budgets: TEST_BUDGETS,
})
export class RetryingChaosApplication {}

@Application({
  name: "fragile-chaos-application",
  modelProvider: FragileModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [ChaosWorkflow],
  providers: [FragileModelProvider],
  budgets: TEST_BUDGETS,
})
export class FragileChaosApplication {}
