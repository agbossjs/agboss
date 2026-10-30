import {
  ApplicationContext,
  Clock,
  ExecutionContext,
  Injectable,
  SqliteConnection,
  SqliteExecutionLeaseRepository,
  SqliteFencedEffectRepository,
  type ExecutionEndEvent,
  type ExecutionLease,
  type InputOf,
  type OutputOf,
} from "@agboss/core";
import type { Milliseconds } from "@agboss/core/units";
import {
  PaymentLedgerRepository,
  type PaymentChargeRow,
} from "../../../../../src/credit/repositories/payment-ledger.repository.js";
import { ChargeCardAction } from "../../../../../src/credit/actions/charge-card.action.js";
import { DeskMetricsObserver } from "../../../../../src/desk/observers/desk-metrics.observer.js";
import { DeskMetricsService } from "../../../../../src/desk/services/desk-metrics.service.js";

/**
 * #472: a crash after the charge and before the step's checkpoint, with the public API only — the
 * test's replacements for the lease store (an instance the test kills takes no lease and renews
 * none: what a dead process looks like to the shared file), the charge action (its first charge
 * waits until its instance has lost the lease, so the step's checkpoint is never written) and an
 * observer that sees the recovered execution end.
 */

/** One charge the action made: on which instance, under which step key, what it answered. */
export interface ChargeSeen {
  readonly instanceId: string;
  readonly idempotencyKey: string;
  readonly chargeId: string;
  /** The customer's charges in the ledger right after this one, read back from the file. */
  readonly ledger: readonly PaymentChargeRow[];
}

export const crash = {
  dead: new Set<string>(),
  charges: [] as ChargeSeen[],
  ends: [] as ExecutionEndEvent[],
  /** Called once the first charge is made, while its step still holds. */
  charged: undefined as (() => void) | undefined,
  /** Lets a held step go after a test that failed, so its app can close. */
  release: (): void => undefined,
};

export function resetCrash(): void {
  crash.release();
  crash.dead.clear();
  crash.charges.length = 0;
  crash.ends.length = 0;
  crash.charged = undefined;
}

/** The leases on the shared file; a killed instance takes none and renews none. */
@Injectable({ deps: [SqliteConnection, Clock, ApplicationContext] })
export class MortalExecutionLeaseRepository extends SqliteExecutionLeaseRepository {
  readonly #instanceId: string;

  constructor(connection: SqliteConnection, clock: Clock, applicationContext: ApplicationContext) {
    super(connection, clock, applicationContext);
    this.#instanceId = applicationContext.instanceId;
  }

  override acquire(
    tenantId: string,
    rootExecutionId: string,
    lease: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    if (crash.dead.has(this.#instanceId)) return Promise.resolve(undefined);
    return super.acquire(tenantId, rootExecutionId, lease);
  }

  override renew(executionLease: ExecutionLease, lease: Milliseconds): Promise<boolean> {
    if (crash.dead.has(this.#instanceId)) return Promise.resolve(false);
    return super.renew(executionLease, lease);
  }
  override yield(executionLease: ExecutionLease): Promise<boolean> {
    if (crash.dead.has(this.#instanceId)) return Promise.resolve(false);
    return super.yield(executionLease);
  }

  override reclaim(
    executionLease: ExecutionLease,
    lease: Milliseconds,
  ): Promise<ExecutionLease | undefined> {
    if (crash.dead.has(this.#instanceId)) return Promise.resolve(undefined);
    return super.reclaim(executionLease, lease);
  }
}

/** Resolves when the signal aborts. */
const abortOf = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) resolve();
    signal.addEventListener("abort", () => {
      resolve();
    });
  });

/** The real charge; its first one holds its step after the charge until the instance lost the lease. */
@Injectable({
  deps: [
    ExecutionContext,
    SqliteFencedEffectRepository,
    PaymentLedgerRepository,
    ApplicationContext,
  ],
})
export class CrashAfterChargeAction extends ChargeCardAction {
  constructor(
    private readonly context: ExecutionContext,
    fencedEffects: SqliteFencedEffectRepository,
    private readonly ledger: PaymentLedgerRepository,
    private readonly applicationContext: ApplicationContext,
  ) {
    super(context, fencedEffects, ledger);
  }

  override async execute(input: InputOf<ChargeCardAction>): Promise<OutputOf<ChargeCardAction>> {
    const charge = await super.execute(input);
    crash.charges.push({
      instanceId: this.applicationContext.instanceId,
      idempotencyKey: this.context.step.idempotencyKey,
      chargeId: charge.chargeId,
      ledger: this.ledger.chargesOf(input.order.value.customerId),
    });
    if (crash.charges.length === 1) {
      const released = new Promise<void>((resolve) => {
        crash.release = resolve;
      });
      crash.charged?.();
      // the charge is committed; the step is not done until its instance has lost the lease
      await Promise.race([abortOf(this.context.signal), released]);
    }
    return charge;
  }
}

/** The application's observer, and every execution end it sees. */
@Injectable({ deps: [DeskMetricsService] })
export class EndsSeenObserver extends DeskMetricsObserver {
  override onExecutionEnd(event: ExecutionEndEvent): void {
    crash.ends.push(event);
    super.onExecutionEnd(event);
  }
}

/** Until an execution of the workflow ended (a recovery runs in the background of its instance). */
export async function endOf(workflow: string): Promise<ExecutionEndEvent> {
  for (let tick = 0; tick < 2000; tick += 1) {
    const ended = crash.ends.find((event) => event.workflow.name === workflow);
    if (ended !== undefined) return ended;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`no execution of ${workflow} ended`);
}
