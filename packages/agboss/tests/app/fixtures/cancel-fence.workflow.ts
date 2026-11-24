import { onEffectCommit } from "../../../src/infrastructure/in-memory-effect-writes.js";
import { Text, WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Action,
  ChildPlacement,
  Idempotency,
  InMemoryFencedEffectRepository,
  Injectable,
  OutboundRecovery,
  Reconciliation,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type Tracked,
  Observer, Ttl,
} from "../../../src/index.js";
import { hours, seconds } from "../../../src/units/index.js";
import { Application } from "../../../src/application/application.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { onStart } from "../../helpers/flow.js";
import { IdempotencyKeyEnvironment } from "../../helpers/idempotency-key.environment.js";
import { gate } from "./fenced-effect.workflow.js";

/**
 * #909 — an order reserved (undone by a release, itself a fenced effect), then charged: through a
 * fenced effect, through an outbound call, and in a `ChildPlacement.AnyWorker` child. The charge
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
@Observer()
export class CancelFenceObserver {
  onIdempotencyRun(event: { readonly name: string; readonly outcome: string }): void {
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
  deps: [Idempotency],
})
export class ReleaseReservationAction {
  constructor(private readonly idempotency: Idempotency) {}

  async execute(input: { readonly reservation: Tracked<ReservationDto> }): Promise<void> {
    const { reservationId } = input.reservation;
    await this.idempotency.runOnce({
      name: "release",
      ttl: hours(24),
      execute: () => {
        onEffectCommit(() => seen.released.push(reservationId));
        return { reservationId };
      },
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
  execute(input: { readonly message: Tracked<WorkflowStartTextDto> }): Promise<ReservationDto> {
    seen.reserved.push(input.message.text);
    return Promise.resolve({ reservationId: `reservation-${input.message.text}` });
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
  deps: [Idempotency],
})
export class ChargeReservationAction {
  constructor(private readonly idempotency: Idempotency) {}

  execute(input: { readonly reservation: Tracked<ReservationDto> }): Promise<ReceiptDto> {
    const { reservationId } = input.reservation;
    return charged(async () => {
      const outcome = await this.idempotency.runOnce({
        name: "charge",
        ttl: hours(24),
        execute: () => {
          onEffectCommit(() => seen.charged.push(reservationId));
          return { receipt: `charged ${reservationId}` };
        },
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
  deps: [Idempotency],
})
export class PayReservationAction {
  constructor(private readonly idempotency: Idempotency) {}

  execute(input: { readonly reservation: Tracked<ReservationDto> }): Promise<ReceiptDto> {
    const { reservationId } = input.reservation;
    return charged(async () => {
      const outcome = await this.idempotency.sendOnce({
        name: "pay",
        target: "payments",
        operation: "charge",
        request: { reservationId },
        timeout: seconds(15),
        ttl: hours(48),
        send: () => {
          seen.requests.push(reservationId);
          return { receipt: `paid ${reservationId}` };
        },
        recovery: OutboundRecovery.permanentLookup<never>(() => Reconciliation.notExecuted()),
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
  deps: [Idempotency],
})
export class ChargeTextAction {
  constructor(private readonly idempotency: Idempotency) {}

  execute(input: { readonly message: Tracked<WorkflowStartTextDto> }): Promise<ReceiptDto> {
    const { text } = input.message;
    return charged(async () => {
      const outcome = await this.idempotency.runOnce({
        name: "charge",
        ttl: hours(24),
        execute: () => {
          onEffectCommit(() => seen.charged.push(text));
          return { receipt: `charged ${text}` };
        },
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
  historyTtl: Ttl.Forever,
  flow: [
    onStart(FenceChargeStart)
      .toAction(ReserveOrderAction)
      .toAction(ChargeReservationAction)
      .toFinish(FenceChargeFinish),
  ],
})
export class FenceChargeWorkflow {}

@Workflow({
  name: "fence-pay-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(FencePayStart)
      .toAction(ReserveOrderAction)
      .toAction(PayReservationAction)
      .toFinish(FencePayFinish),
  ],
})
export class FencePayWorkflow {}

@Workflow({
  placement: ChildPlacement.AnyWorker,
  name: "fence-child-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(FenceChildStart)
      .toAction(ChargeTextAction)
      .toFinish(FenceChildFinish),
  ],
})
export class FenceChildWorkflow {}

@Workflow({
  name: "fence-far-workflow",
  version: "1.0.0",
  historyTtl: Ttl.Forever,
  flow: [
    onStart(FenceFarStart)
      .toWorkflow(FenceChildWorkflow)
      .toFinish(FenceFarFinish),
  ],
})
export class FenceFarWorkflow {}

@Application({
  name: "cancel-fence-application",
  version: "1.0.0",
  environment: IdempotencyKeyEnvironment,
  workflows: [FenceChargeWorkflow, FencePayWorkflow, FenceFarWorkflow],
  observers: [CancelFenceObserver],
  budgets: TEST_BUDGETS,
  providers: [InMemoryFencedEffectRepository],
})
export class CancelFenceApplication {}
