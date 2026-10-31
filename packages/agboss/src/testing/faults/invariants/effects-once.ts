import {
  ExecutionLeaseEventKind,
  FencedEffectEventOutcome,
  OutboundCallEventOutcome,
  type ExecutionLeaseEventRecord,
} from "../../../infrastructure/execution-lease-event.repository.js";
import type { FaultRun } from "../facts.js";
import { orderExecutionsOf, type OrderExecution } from "./order-executions.js";
import { FaultInvariant, violation, type FaultViolation } from "./violations.js";

/**
 * Every charge exactly once (#484 invariant 3):
 * - an order execution that finished has one business row (`charge:<executionId>`), one that
 *   failed for real none, and none has two;
 * - its fenced effect `Ran` once in the lease log, every other call `Replayed`, `Joined` or
 *   `Refused`;
 * - each order was paid at most once at the gateway — once when any of its executions finished —,
 *   reached it at most once (a call left pending is reconciled, never resent), always with one
 *   idempotency key, and the lease log has at most one `Sent` of it.
 */

/** Every row of every tree's lease log. */
const rowsOf = (run: FaultRun): readonly ExecutionLeaseEventRecord[] =>
  run.trees.flatMap((tree) => tree.leaseEvents);

/** The business rows and the effect's log rows of one execution. */
function chargeViolations(run: FaultRun, execution: OrderExecution): FaultViolation[] {
  const { executionId, orderId } = execution;
  const rows = run.businessRows.filter((row) => row === `charge:${executionId}`).length;
  const expected = execution.status === "finished" ? 1 : 0;
  const found: FaultViolation[] = [];
  if (rows > 1 || (execution.status === "finished" && rows !== expected))
    found.push(
      violation(
        FaultInvariant.EffectsOnce,
        `${orderId} (${executionId}, ${execution.status}) has ${String(rows)} business rows, not ${String(expected)}`,
      ),
    );
  const outcomes = rowsOf(run).flatMap((row) =>
    row.kind === ExecutionLeaseEventKind.FencedEffect &&
    row.executionId === executionId &&
    row.name === "charge"
      ? [row.outcome]
      : [],
  );
  const ran = outcomes.filter((outcome) => outcome === FencedEffectEventOutcome.Ran).length;
  if (ran > 1)
    found.push(
      violation(
        FaultInvariant.EffectsOnce,
        `the charge of ${orderId} (${executionId}) ran ${String(ran)} times in the lease log: ${outcomes.join(", ")}`,
      ),
    );
  return found;
}

/** One order's payments, requests and `Sent` rows. */
function payViolations(
  run: FaultRun,
  orderId: string,
  executions: readonly OrderExecution[],
): FaultViolation[] {
  const own = new Set(executions.map((execution) => execution.executionId));
  const isPaid = executions.some((execution) => execution.status === "finished");
  const requests = run.requests.filter((request) => request.orderId === orderId);
  const keys = new Set(requests.map((request) => request.idempotencyKey));
  const payments = run.payments.filter((payment) => keys.has(payment.idempotencyKey));
  const sent = rowsOf(run).filter(
    (row) =>
      row.kind === ExecutionLeaseEventKind.OutboundCall &&
      row.outcome === OutboundCallEventOutcome.Sent &&
      own.has(row.executionId),
  );
  const found: FaultViolation[] = [];
  if (keys.size > 1)
    found.push(
      violation(
        FaultInvariant.EffectsOnce,
        `${orderId} reached the gateway under ${String(keys.size)} idempotency keys: ${[...keys].join(", ")}`,
      ),
    );
  if (requests.length > 1)
    found.push(
      violation(
        FaultInvariant.EffectsOnce,
        `${orderId} reached the gateway ${String(requests.length)} times (from ${requests.map((request) => request.pod).join(", ")}): a pending call was resent, not reconciled`,
      ),
    );
  if (payments.length > 1 || (isPaid && payments.length !== 1))
    found.push(
      violation(
        FaultInvariant.EffectsOnce,
        `${orderId} was paid ${String(payments.length)} times at the gateway`,
      ),
    );
  return [...found, ...sentViolations(orderId, sent.length)];
}

/** At most one `Sent` row per order. */
const sentViolations = (orderId: string, sent: number): FaultViolation[] =>
  sent > 1
    ? [
        violation(
          FaultInvariant.EffectsOnce,
          `${orderId} has ${String(sent)} Sent rows in the lease log`,
        ),
      ]
    : [];

/** Every violation of one effect per key. */
export function effectsOnceViolations(run: FaultRun): FaultViolation[] {
  const executions = orderExecutionsOf(run);
  const orders = [...new Set(run.orders.map((order) => order.orderId))];
  return [
    ...executions.flatMap((execution) => chargeViolations(run, execution)),
    ...orders.flatMap((orderId) =>
      payViolations(
        run,
        orderId,
        executions.filter((execution) => execution.orderId === orderId),
      ),
    ),
  ];
}
