import { DtoValidationError } from "../dto/errors.js";
import { tenantRead } from "../flow/context/context-values.js";
import { shownCallOf } from "../infrastructure/fenced-effect-key.js";
import {
  DEFAULT_OUTBOUND_CALL_PAGE,
  MAX_OUTBOUND_CALL_PAGE,
  OutboundCallStatus,
  type OutboundCallPage,
  type OutboundCallRepository,
} from "../infrastructure/outbound-call.repository.js";
import type { LeaseEventsQuery, PendingOutboundCallsQuery } from "../app/types.js";
import {
  currentLeaseEventOf,
  type ExecutionLeaseEventRecord,
  type ExecutionLeaseEventRepository,
} from "../infrastructure/execution-lease-event.repository.js";

/**
 * `app.leaseEventsOf({ tenantId, rootExecutionId })` (#501): the tree's rows of the lease log,
 * oldest first — a row written before #825 under this version's names (`currentLeaseEventOf`).
 */
export async function leaseEventsIn(
  leaseEvents: ExecutionLeaseEventRepository,
  { tenantId, rootExecutionId }: LeaseEventsQuery,
): Promise<readonly ExecutionLeaseEventRecord[]> {
  const rows = await leaseEvents.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt(
    tenantId,
    rootExecutionId,
  );
  return rows.map(currentLeaseEventOf);
}

/**
 * `app.pendingOutboundCallsOf({ tenantId, limit?, after? })` (#505, #825): a page of a tenant's calls
 * left pending, by the store's cursor — its tenant id a key's text, its limit and cursor checked
 * before the store is read, each call shown as every read shows it (a business key by its handle).
 */
export function pendingCallsOf(
  outboundCalls: OutboundCallRepository,
  { tenantId, limit, after }: PendingOutboundCallsQuery,
): Promise<OutboundCallPage> {
  return tenantRead(tenantId, async () => {
    const status = OutboundCallStatus.Pending;
    const query = { tenantId, status, limit: pageLimitOf(limit), ...afterOf(after) };
    const page = await outboundCalls.findAllByTenantIdAndStatus(query).catch(cursorRefused);
    const calls = page.calls.map(shownCallOf);
    return page.next === undefined ? { calls } : { calls, next: page.next };
  });
}

/** What `app.pendingOutboundCallsOf` reads (#825): its error's DTO. */
const PENDING_QUERY = "PendingOutboundCallsQuery";

/** A page's size (#825): the default, or a whole number from 1 to the largest — `dto.invalid` else. */
function pageLimitOf(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_OUTBOUND_CALL_PAGE;
  if (Number.isInteger(limit) && limit >= 1 && limit <= MAX_OUTBOUND_CALL_PAGE) return limit;
  const reason = `a page is a whole number of calls from 1 to ${String(MAX_OUTBOUND_CALL_PAGE)}`;
  throw new DtoValidationError(PENDING_QUERY, [{ path: "limit", reason }]);
}

/**
 * A cursor the store does not read as one of its own (its `RangeError`, the limit checked before):
 * `dto.invalid` naming `after`, as the other arguments are refused.
 */
function cursorRefused(error: unknown): never {
  if (!(error instanceof RangeError)) throw error;
  const reason = "a cursor is the next of a page before, as the store gave it";
  throw new DtoValidationError(PENDING_QUERY, [{ path: "after", reason }]);
}

/** A page's cursor (#825): a non-empty text a page before gave as `next` — `dto.invalid` else. */
function afterOf(after: string | undefined): { readonly after?: string } {
  if (after === undefined) return {};
  if (typeof after === "string" && after !== "") return { after };
  const reason = "a cursor is the next of a page before: a non-empty text";
  throw new DtoValidationError(PENDING_QUERY, [{ path: "after", reason }]);
}
