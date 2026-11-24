import { onEffectCommit } from "../../../src/infrastructure/in-memory-effect-writes.js";
import { WorkflowFinishTextDto, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Action,
  ExecutionContext,
  Idempotency,
  InMemoryFencedEffectRepository,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Tracked,
} from "../../../src/index.js";
import { hours, seconds } from "../../../src/units/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { onStart, toAction } from "../../helpers/flow.js";
import { StepError } from "../../../src/core/error-families/step-errors.js";
import { IdempotencyKeyEnvironment } from "../../helpers/idempotency-key.environment.js";

/**
 * #1318e: an @Action with a timeout whose `execute` keeps running past it. `seen` is what it did, and
 * `release()` lets every hanging `execute` go on — the late completion the framework must not trust.
 */
export const seen = {
  /** The effects of a guarded action's `runOnce`. */
  effects: 0,
  /** What an action did to its own store, outside the framework. */
  ownWrites: 0,
  /** The raw effects (a direct call, outside `Idempotency`) of the mixed action. */
  rawEffects: 0,
  /** How many times `execute` was entered. */
  entered: 0,
  signal: undefined as AbortSignal | undefined,
  /** What a late `runOnce` of the orphaned unguarded action met. */
  lateError: undefined as unknown,
  lateRan: false,
  release: (): void => undefined,
  gate: Promise.resolve(),
};

export function resetSeen(): void {
  seen.effects = 0;
  seen.ownWrites = 0;
  seen.rawEffects = 0;
  seen.entered = 0;
  seen.signal = undefined;
  seen.lateError = undefined;
  seen.lateRan = false;
  seen.gate = new Promise<void>((resolve) => {
    seen.release = resolve;
  });
}

interface Message {
  readonly message: Tracked<WorkflowStartTextDto>;
}

/** No `Idempotency` before its timeout; after it, it writes through the framework and to its own store. */
@Action({
  name: "unguarded-action",
  description: "Hangs past its timeout, then writes",
  input: { message: WorkflowStartTextDto },
  output: WorkflowFinishTextDto,
  timeout: seconds(5),
  deps: [ExecutionContext, Idempotency],
})
export class UnguardedAction {
  constructor(
    private readonly context: ExecutionContext,
    private readonly idempotency: Idempotency,
  ) {}

  async execute(input: Message): Promise<WorkflowFinishTextDto> {
    seen.entered += 1;
    seen.signal = this.context.signal;
    await seen.gate;
    seen.ownWrites += 1;
    try {
      await this.idempotency.runOnce({
        name: "late",
        key: input.message.text,
        withoutFingerprint: true,
        ttl: hours(24),
        execute: () => {
          seen.lateRan = true;
          return { done: true };
        },
      });
    } catch (error) {
      seen.lateError = error;
    }
    return { text: "late" };
  }
}

/** Every effect through `runOnce`: a retry under the same key is safe. */
@Action({
  name: "guarded-action",
  description: "Charges once per key",
  input: { message: WorkflowStartTextDto },
  output: WorkflowFinishTextDto,
  timeout: seconds(5),
  deps: [Idempotency],
})
export class GuardedAction {
  constructor(private readonly idempotency: Idempotency) {}

  async execute(input: Message): Promise<WorkflowFinishTextDto> {
    seen.entered += 1;
    await this.idempotency.runOnce({
      name: "charge",
      key: input.message.text,
      withoutFingerprint: true,
      ttl: hours(24),
      execute: async () => {
        await seen.gate;
        // the effect is part of the transaction: a refused or revoked one never applies it
        onEffectCommit(() => {
          seen.effects += 1;
        });
        return { done: true };
      },
    });
    return { text: "charged" };
  }
}

/** One `runOnce` AND a raw effect; its first attempt hangs past the timeout, later ones finish. */
const mixedOptions = {
  description: "Charges through runOnce and by a raw call",
  input: { message: WorkflowStartTextDto },
  output: WorkflowFinishTextDto,
  timeout: seconds(5),
  deps: [Idempotency],
} as const;

@Action({ ...mixedOptions, name: "mixed-action" })
export class MixedAction {
  constructor(private readonly idempotency: Idempotency) {}

  async execute(input: Message): Promise<WorkflowFinishTextDto> {
    seen.entered += 1;
    const attempt = seen.entered;
    await this.idempotency.runOnce({
      name: "charge",
      key: input.message.text,
      withoutFingerprint: true,
      ttl: hours(24),
      execute: () => {
        onEffectCommit(() => {
          seen.effects += 1;
        });
        return { done: true };
      },
    });
    seen.rawEffects += 1;
    if (attempt === 1) await seen.gate;
    return { text: "charged" };
  }
}

/** The same code as `MixedAction` as the first try and as the explicit retry: one class is one node. */
@Action({ ...mixedOptions, name: "mixed-first-action" })
export class MixedFirstAction extends MixedAction {}

@Action({ ...mixedOptions, name: "mixed-retry-action" })
export class MixedRetryAction extends MixedAction {}

@WorkflowStart({
  name: "unguarded-timeout-workflow-start",
  description: "A key",
  input: WorkflowStartTextDto,
})
export class UnguardedStart {}

@WorkflowStart({
  name: "guarded-timeout-workflow-start",
  description: "A key",
  input: WorkflowStartTextDto,
})
export class GuardedStart {}

@WorkflowStart({
  name: "mixed-timeout-workflow-start",
  description: "A key",
  input: WorkflowStartTextDto,
})
export class MixedStart {}

@WorkflowStart({
  name: "mixed-retry-workflow-start",
  description: "A key, retried by the flow",
  input: WorkflowStartTextDto,
})
export class MixedRetryStart {}

@WorkflowFinish({
  name: "timeout-workflow-finish",
  description: "Done",
  output: WorkflowFinishTextDto,
})
export class TimeoutFinish {}

@Workflow({
  name: "action-timeout-workflow",
  version: "1.0.0",
  flow: [
    onStart(UnguardedStart).toAction(UnguardedAction).toFinish(TimeoutFinish),
    onStart(GuardedStart).toAction(GuardedAction).toFinish(TimeoutFinish),
    onStart(MixedStart).toAction(MixedAction).toFinish(TimeoutFinish),
    onStart(MixedRetryStart)
      .toAction(MixedFirstAction)
      .onError(StepError.ActionOutcomeUnknown, toAction(MixedRetryAction).toFinish(TimeoutFinish))
      .toFinish(TimeoutFinish),
  ],
})
export class ActionTimeoutWorkflow {}

@Application({
  name: "action-timeout-application",
  version: "1.0.0",
  environment: IdempotencyKeyEnvironment,
  workflows: [ActionTimeoutWorkflow],
  providers: [InMemoryFencedEffectRepository],
  budgets: TEST_BUDGETS,
})
export class ActionTimeoutApplication {}
