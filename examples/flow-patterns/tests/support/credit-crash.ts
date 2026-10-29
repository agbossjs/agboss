import {
  ApplicationContext,
  Clock,
  ExecutionContext,
  Injectable,
  SqliteConnection,
  SqliteExecutionLeaseRepository,
  type ExecutionEndEvent,
  type ExecutionLease,
} from "@agboss/core";
import type { Milliseconds } from "@agboss/core/units";
import {
  PaymentLedgerRepository,
  type PaymentChargeRow,
} from "../../src/credit/repositories/payment-ledger.repository.js";
import {
  PaymentService,
  type Charge,
  type ChargeRequest,
} from "../../src/credit/services/payment.service.js";
import { DeskMetricsObserver } from "../../src/desk/observers/desk-metrics.observer.js";
import { DeskMetricsService } from "../../src/desk/services/desk-metrics.service.js";

/**
 * #472: a crash after the charge and before the step's checkpoint, with the public API only — the
 * test's replacements for the lease store (an instance the test kills takes no lease and renews
 * none: what a dead process looks like to the shared file), the payment service (its first charge
 * waits until its instance has lost the lease, so the step's checkpoint is never written) and an
 * observer that sees the recovered execution end.
 */

/** One charge the payment service made: on which instance, under which key, what it answered. */
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
}

/** Resolves when the signal aborts. */
const abortOf = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) resolve();
    signal.addEventListener("abort", () => {
      resolve();
    });
  });

/** The real payment service; its first charge holds its step until the instance lost the lease. */
@Injectable({ deps: [PaymentLedgerRepository, ExecutionContext, ApplicationContext] })
export class CrashAfterChargePaymentService extends PaymentService {
  constructor(
    private readonly ledger: PaymentLedgerRepository,
    private readonly executionContext: ExecutionContext,
    private readonly applicationContext: ApplicationContext,
  ) {
    super(ledger);
  }

  override async charge(request: ChargeRequest): Promise<Charge> {
    const charge = await super.charge(request);
    crash.charges.push({
      instanceId: this.applicationContext.instanceId,
      idempotencyKey: request.idempotencyKey,
      chargeId: charge.chargeId,
      ledger: this.ledger.chargesOf(request.customerId),
    });
    if (crash.charges.length === 1) {
      const released = new Promise<void>((resolve) => {
        crash.release = resolve;
      });
      crash.charged?.();
      // the external charge is made; the step is not done until its instance has lost the lease
      await Promise.race([abortOf(this.executionContext.signal), released]);
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
