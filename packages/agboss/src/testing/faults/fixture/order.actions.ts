import {
  Action,
  ApplicationContext,
  ExecutionContext,
  Idempotency,
  type Produced,
} from "../../../index.js";
import { FAULT_BUSINESS_ROWS, type FaultBusinessRows } from "../fault-stores.js";
import { hours } from "../../../units/index.js";
import { fenceOf } from "../../../flow/context/execution-fence.js";
import { FaultChargeDto, FaultReservationDto, FaultOrderDto } from "./order.dto.js";
import { FaultPodLink, FaultStepPoint } from "./pod-link.js";

/**
 * The fault fixture's undoable reservation and its fenced charge (#484): the reservation is undone
 * only on a real failure (a declined charge), never on a hand-over; the charge writes one business
 * row per execution in the fenced effect's transaction (`charge:<executionId>`), so a zombie's
 * write and a replay are told apart from a second charge.
 */

/** A real failure: the card was declined. The tree fails, its reservation undone. */
export class FaultChargeDeclinedError extends Error {
  override name = "FaultChargeDeclinedError";
}

/** Where a step runs: its instance, execution, tree and lease token. */
export const whereOf = (
  applicationContext: ApplicationContext,
  executionContext: ExecutionContext,
): Readonly<Record<string, unknown>> => ({
  instanceId: applicationContext.instanceId,
  executionId: executionContext.executionId,
  rootExecutionId: executionContext.root.executionId,
  tenantId: executionContext.tenant.tenantId,
  token: fenceOf(executionContext).token,
});

@Action({
  name: "fault-release-action",
  description: "Undoes the order's reservation",
  input: { reservation: FaultReservationDto },
  deps: [ApplicationContext, ExecutionContext, FaultPodLink],
})
export class FaultReleaseAction {
  constructor(
    private readonly applicationContext: ApplicationContext,
    private readonly executionContext: ExecutionContext,
    private readonly faultPodLink: FaultPodLink,
  ) {}

  async execute(input: {
    readonly reservation: Produced<FaultReservationDto, unknown>;
  }): Promise<void> {
    const { orderId } = input.reservation.value;
    const where = whereOf(this.applicationContext, this.executionContext);
    await this.faultPodLink.atStep(
      FaultStepPoint.Release,
      { ...where, orderId },
      this.executionContext.signal,
    );
    this.faultPodLink.emit("released", { ...where, orderId });
  }
}

@Action({
  name: "fault-reserve-action",
  description: "Reserves the order",
  input: { order: FaultOrderDto },
  output: FaultReservationDto,
  compensateWith: FaultReleaseAction,
  deps: [ApplicationContext, ExecutionContext, FaultPodLink],
})
export class FaultReserveAction {
  constructor(
    private readonly applicationContext: ApplicationContext,
    private readonly executionContext: ExecutionContext,
    private readonly faultPodLink: FaultPodLink,
  ) {}

  async execute(input: {
    readonly order: Produced<FaultOrderDto, unknown>;
  }): Promise<FaultReservationDto> {
    const { orderId, decline } = input.order.value;
    const where = whereOf(this.applicationContext, this.executionContext);
    await this.faultPodLink.atStep(
      FaultStepPoint.Reserve,
      { ...where, orderId },
      this.executionContext.signal,
    );
    this.faultPodLink.emit("reserved", { ...where, orderId });
    return { orderId, decline, reservationId: `reservation:${orderId}` };
  }
}

/**
 * The charge's id: the work's result — a store that answered `Ran` for a write it never ran (#928
 * S2b's sabotage) gives none, and the fixture's own receipt stands.
 */
const chargeIdOf = (result: unknown, receipt: { readonly chargeId: string }): string =>
  typeof result === "object" && result !== null && "chargeId" in result
    ? String(result.chargeId)
    : receipt.chargeId;

@Action({
  name: "fault-charge-action",
  description: "Charges the order: one business row, in the fenced effect's transaction",
  input: { reservation: FaultReservationDto },
  output: FaultChargeDto,
  deps: [ApplicationContext, ExecutionContext, Idempotency, FAULT_BUSINESS_ROWS, FaultPodLink],
})
export class FaultChargeAction {
  constructor(
    private readonly applicationContext: ApplicationContext,
    private readonly executionContext: ExecutionContext,
    private readonly idempotency: Idempotency,
    private readonly faultBusinessRows: FaultBusinessRows,
    private readonly faultPodLink: FaultPodLink,
  ) {}

  async execute(input: {
    readonly reservation: Produced<FaultReservationDto, unknown>;
  }): Promise<FaultChargeDto> {
    const { orderId, decline } = input.reservation.value;
    const { signal } = this.executionContext;
    const where = { ...whereOf(this.applicationContext, this.executionContext), orderId };
    await this.faultPodLink.atStep(FaultStepPoint.ChargeBefore, where, signal);
    if (decline) throw new FaultChargeDeclinedError(`the card of ${orderId} was declined`);
    const row = `charge:${this.executionContext.executionId}`;
    const receipt = { chargeId: `${row}@${String(fenceOf(this.executionContext).token)}` };
    const outcome = await this.idempotency.runOnce({
      name: "charge",
      ttl: hours(24),
      execute: () => {
        const inserted = this.faultBusinessRows.insert(row);
        return inserted === undefined ? receipt : inserted.then(() => receipt);
      },
    });
    this.faultPodLink.emit("charged", { ...where, status: outcome.status });
    await this.faultPodLink.atStep(FaultStepPoint.ChargeAfter, where, signal);
    return { orderId, chargeId: chargeIdOf(outcome.result, receipt) };
  }
}
