import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Action,
  ChildPlacement,
  ExecutionContext,
  InMemoryFencedEffectRepository,
  Injectable,
  NotSentTrust,
  OutboundCallReconciliation,
  OutboundCalls,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  effectKeyOf,
  type OnFencedEffect,
  type OnOutboundCall,
  type Produced,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";
import { IdempotencyKeyEnvironment } from "../../helpers/idempotency-key.environment.js";
import { gate } from "./fenced-effect.workflow.js";

/**
 * #909 — an order reserved (undone by a release, itself a fenced effect), then charged: through a
 * fenced effect, through an outbound call, and in a `ChildPlacement.AnyInstance` child. The charge
 * waits at the gate of `fenced-effect.workflow.ts` before its write — a live holder between its
 * tree's cancel request and its next renewal. Every write, request and undo is kept.
 */

/** What ran: the writes, the sends the other system took, the undo, what the step saw. */
export const seen = {
  reserved: [] as string[],
  charged: [] as string[],
  requests: [] as string[],
  released: [] as string[],
  refusals: [] as unknown[],
  fenced: [] as { readonly name: string; readonly outcome: string }[],
  calls: [] as {
    readonly name: string;
    readonly outcome: string;
    readonly status: string;
    readonly attempt: number;
  }[],
};

export function resetSeen(): void {
  for (const list of Object.values(seen)) list.length = 0;
}

/** What a step does when its write is refused by the cancel: it lets the error go, or swallows it. */
export const behaviour = { isSwallowing: false };

export class ReservationDto {
  @Text({ prompt: "the reservation's id" })
  reservationId!: string;
}

export class ReceiptDto {
  @Text({ prompt: "the receipt" })
  receipt!: string;
}

/** Keeps the audit events of the fenced writes and the calls. */
@Injectable()
export class CancelFenceObserver implements OnFencedEffect, OnOutboundCall {
  onFencedEffect(event: { readonly name: string; readonly outcome: string }): void {
    seen.fenced.push({ name: event.name, outcome: event.outcome });
  }
  onOutboundCall(event: {
    readonly name: string;
    readonly outcome: string;
    readonly status: string;
    readonly attempt: number;
  }): void {
    seen.calls.push({
      name: event.name,
      outcome: event.outcome,
      status: event.status,
      attempt: event.attempt,
    });
  }
}

/** The undo of a reservation: a fenced effect of its own, which a cancel never refuses. */
@Action({
  name: "release-reservation-action",
  description: "Releases the reservation, through a fenced effect",
  input: { reservation: ReservationDto },
  deps: [ExecutionContext, InMemoryFencedEffectRepository],
})
export class ReleaseReservationAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly fencedEffects: InMemoryFencedEffectRepository,
  ) {}

  async execute(input: { readonly reservation: Produced<ReservationDto, unknown> }): Promise<void> {
    const { reservationId } = input.reservation.value;
    const key = effectKeyOf(this.executionContext, "release");
    await this.fencedEffects.runOnce(key, (transaction) => {
      transaction.onCommit(() => seen.released.push(reservationId));
      return { reservationId };
    });
  }
}

@Action({
  name: "reserve-order-action",
  description: "Reserves the order; its undo releases it",
  input: { message: WorkflowStartTextDto },
  output: ReservationDto,
  compensateWith: ReleaseReservationAction,
})
export class ReserveOrderAction {
  execute(input: {
    readonly message: Produced<WorkflowStartTextDto, unknown>;
  }): Promise<ReservationDto> {
    seen.reserved.push(input.message.value.text);
    return Promise.resolve({ reservationId: `reservation-${input.message.value.text}` });
  }
}

/** Runs `write`; a refusal by the cancel is what the step saw — swallowed when the lever says so. */
async function charged(write: () => Promise<ReceiptDto>): Promise<ReceiptDto> {
  await gate("before");
  try {
    return await write();
  } catch (error) {
    seen.refusals.push(error);
    if (!behaviour.isSwallowing) throw error;
    return { receipt: "swallowed" };
  }
}

@Action({
  name: "charge-reservation-action",
  description: "Charges the reservation through a fenced effect",
  input: { reservation: ReservationDto },
  output: ReceiptDto,
  deps: [ExecutionContext, InMemoryFencedEffectRepository],
})
export class ChargeReservationAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly fencedEffects: InMemoryFencedEffectRepository,
  ) {}

  execute(input: { readonly reservation: Produced<ReservationDto, unknown> }): Promise<ReceiptDto> {
    const { reservationId } = input.reservation.value;
    const key = effectKeyOf(this.executionContext, "charge");
    return charged(async () => {
      const outcome = await this.fencedEffects.runOnce(key, (transaction) => {
        transaction.onCommit(() => seen.charged.push(reservationId));
        return { receipt: `charged ${reservationId}` };
      });
      return outcome.result;
    });
  }
}

@Action({
  name: "pay-reservation-action",
  description: "Pays the reservation through a call that leaves the system",
  input: { reservation: ReservationDto },
  output: ReceiptDto,
  deps: [ExecutionContext, OutboundCalls],
})
export class PayReservationAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly outboundCalls: OutboundCalls,
  ) {}

  execute(input: { readonly reservation: Produced<ReservationDto, unknown> }): Promise<ReceiptDto> {
    const { reservationId } = input.reservation.value;
    const key = effectKeyOf(this.executionContext, "pay");
    return charged(async () => {
      const outcome = await this.outboundCalls.send(key, {
        target: "payments",
        operation: "charge",
        request: { reservationId },
        send: () => {
          seen.requests.push(reservationId);
          return { receipt: `paid ${reservationId}` };
        },
        notSent: { trust: NotSentTrust.Lookup },
        reconcile: () => OutboundCallReconciliation.notSent(),
      });
      return outcome.result;
    });
  }
}

@Action({
  name: "charge-text-action",
  description: "Charges the order of a child through a fenced effect",
  input: { message: WorkflowStartTextDto },
  output: ReceiptDto,
  deps: [ExecutionContext, InMemoryFencedEffectRepository],
})
export class ChargeTextAction {
  constructor(
    private readonly executionContext: ExecutionContext,
    private readonly fencedEffects: InMemoryFencedEffectRepository,
  ) {}

  execute(input: {
    readonly message: Produced<WorkflowStartTextDto, unknown>;
  }): Promise<ReceiptDto> {
    const { text } = input.message.value;
    const key = effectKeyOf(this.executionContext, "charge");
    return charged(async () => {
      const outcome = await this.fencedEffects.runOnce(key, (transaction) => {
        transaction.onCommit(() => seen.charged.push(text));
        return { receipt: `charged ${text}` };
      });
      return outcome.result;
    });
  }
}

@WorkflowStart({
  name: "fence-charge-start-workflow-start",
  description: "An order",
  input: WorkflowStartTextDto,
})
export class FenceChargeStart {}
@WorkflowStart({
  name: "fence-pay-start-workflow-start",
  description: "An order",
  input: WorkflowStartTextDto,
})
export class FencePayStart {}
@WorkflowStart({
  name: "fence-child-start-workflow-start",
  description: "An order",
  input: WorkflowStartTextDto,
})
export class FenceChildStart {}
@WorkflowStart({
  name: "fence-far-start-workflow-start",
  description: "An order",
  input: WorkflowStartTextDto,
})
export class FenceFarStart {}
@WorkflowFinish({
  name: "fence-charge-finish-workflow-finish",
  description: "Done",
  output: ReceiptDto,
})
export class FenceChargeFinish {}
@WorkflowFinish({
  name: "fence-pay-finish-workflow-finish",
  description: "Done",
  output: ReceiptDto,
})
export class FencePayFinish {}
@WorkflowFinish({
  name: "fence-child-finish-workflow-finish",
  description: "Done",
  output: ReceiptDto,
})
export class FenceChildFinish {}
@WorkflowFinish({
  name: "fence-far-finish-workflow-finish",
  description: "Done",
  output: ReceiptDto,
})
export class FenceFarFinish {}

@Workflow({
  name: "fence-charge-workflow",
  version: "1.0.0",
  flow: [
    start(FenceChargeStart)
      .returns(WorkflowStartTextDto)
      .toAction(ReserveOrderAction)
      .returns(ReservationDto)
      .toAction(ChargeReservationAction)
      .returns(ReceiptDto)
      .toFinish(FenceChargeFinish),
  ],
})
export class FenceChargeWorkflow {}

@Workflow({
  name: "fence-pay-workflow",
  version: "1.0.0",
  flow: [
    start(FencePayStart)
      .returns(WorkflowStartTextDto)
      .toAction(ReserveOrderAction)
      .returns(ReservationDto)
      .toAction(PayReservationAction)
      .returns(ReceiptDto)
      .toFinish(FencePayFinish),
  ],
})
export class FencePayWorkflow {}

@Workflow({
  name: "fence-child-workflow",
  version: "1.0.0",
  flow: [
    start(FenceChildStart)
      .returns(WorkflowStartTextDto)
      .toAction(ChargeTextAction)
      .returns(ReceiptDto)
      .toFinish(FenceChildFinish),
  ],
})
export class FenceChildWorkflow {}

@Workflow({
  name: "fence-far-workflow",
  version: "1.0.0",
  flow: [
    start(FenceFarStart)
      .returns(WorkflowStartTextDto)
      .toWorkflow(FenceChildWorkflow, { placement: ChildPlacement.AnyInstance })
      .returns(ReceiptDto)
      .toFinish(FenceFarFinish),
  ],
})
export class FenceFarWorkflow {}

@Application({
  name: "cancel-fence-application",
  version: "1.0.0",
  environment: IdempotencyKeyEnvironment,
  idempotencyKeyField: "idempotencyKey",
  workflows: [FenceChargeWorkflow, FencePayWorkflow, FenceFarWorkflow],
  observers: [CancelFenceObserver],
  budgets: TEST_BUDGETS,
  providers: [InMemoryFencedEffectRepository],
})
export class CancelFenceApplication {}
