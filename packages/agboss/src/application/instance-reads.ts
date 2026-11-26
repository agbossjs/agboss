import { ExecutionError } from "../core/error-families/run-errors.js";
import { keyTextRuleOf } from "../core/errors.js";
import { invalidDto } from "../dto/errors.js";
import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";
import { tenantRead, treeRead } from "../flow/context/context-values.js";
import { shownCallOf } from "../infrastructure/fenced-effect-key.js";
import {
  DEFAULT_OUTBOUND_CALL_PAGE,
  MAX_OUTBOUND_CALL_PAGE,
  OutboundCallStatus,
  type OutboundCallPage,
  type OutboundCallRepository,
} from "../infrastructure/outbound-call.repository.js";
import { refuseUnknownFields } from "../app/query-fields.js";
import type { ExecutionTreeQuery, AnyTenantApp, PendingOutboundCallsQuery } from "../app/types.js";
import type { InstanceSurface } from "./compose-app.js";
import { executionReadsOf } from "./execution-listing.js";
import {
  currentAuditEventOf,
  type ExecutionAuditEventRecord,
  type ExecutionAuditLogRepository,
} from "../infrastructure/execution-audit-log.repository.js";

/**
 * `app.auditLogOf({ tenantId, rootExecutionId })` (#501): the tree's rows of the audit log,
 * oldest first — a row written before #825 under this version's names (`currentAuditEventOf`).
 */
export async function auditLogIn(
  auditLog: ExecutionAuditLogRepository,
  { tenantId, rootExecutionId }: ExecutionTreeQuery,
): Promise<readonly ExecutionAuditEventRecord[]> {
  const rows = await auditLog.findAllByTenantIdAndRootExecutionIdOrderByOccurredAt(
    tenantId,
    rootExecutionId,
  );
  return rows.map(currentAuditEventOf);
}

/**
 * `app.pendingOutboundCallsOf({ tenantId, limit?, after? })` (#505, #825): a page of a tenant's calls
 * left pending, by the store's cursor — its tenant id a key's text, its limit and cursor checked
 * before the store is read, each call shown as every read shows it (a business key by its handle).
 */
export async function pendingCallsOf(
  outboundCalls: OutboundCallRepository,
  asked: PendingOutboundCallsQuery,
): Promise<OutboundCallPage> {
  refuseUnknownFields(PENDING_QUERY, asked, PENDING_FIELDS);
  const { tenantId, limit, after } = asked;
  return tenantRead(tenantId, async () => {
    const status = OutboundCallStatus.Pending;
    const query = { tenantId, status, limit: pageLimitOf(limit), ...cursorOf(after) };
    const page = await outboundCalls.findAllByTenantIdAndStatus(query).catch(cursorRefused);
    const calls = page.items.map(shownCallOf);
    return page.nextCursor === undefined ? { calls } : { calls, next: page.nextCursor };
  });
}

/** What `app.pendingOutboundCallsOf` reads (#825): its error's DTO. */
const PENDING_QUERY = "PendingOutboundCallsQuery";
const PENDING_FIELDS: ReadonlySet<string> = new Set(["tenantId", "limit", "after"]);

/** A page's size (#825): the default, or a whole number from 1 to the largest — `validation.dto-invalid` else. */
function pageLimitOf(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_OUTBOUND_CALL_PAGE;
  if (Number.isInteger(limit) && limit >= 1 && limit <= MAX_OUTBOUND_CALL_PAGE) return limit;
  const reason = `a page is a whole number of calls from 1 to ${String(MAX_OUTBOUND_CALL_PAGE)}`;
  throw invalidDto({ dto: PENDING_QUERY, issues: [{ path: "limit", reason }] });
}

/**
 * A cursor the store does not read as one of its own (its `RangeError`, the limit checked before):
 * `validation.dto-invalid` naming `after`, as the other arguments are refused.
 */
function cursorRefused(error: unknown): never {
  if (!(error instanceof RangeError)) throw error;
  const reason = "a cursor is the next of a page before, as the store gave it";
  throw invalidDto({ dto: PENDING_QUERY, issues: [{ path: "after", reason }] });
}

/** A page's cursor (#825): a non-empty text a page before gave as `next` — `validation.dto-invalid` else. */
function cursorOf(after: string | undefined): { readonly cursor?: string } {
  if (after === undefined) return {};
  if (typeof after === "string" && after !== "") return { cursor: after };
  const reason = "a cursor is the next of a page before: a non-empty text";
  throw invalidDto({ dto: PENDING_QUERY, issues: [{ path: "after", reason }] });
}

/** What an operator reads of the instance: its probes, its audit log, its outbound calls. */
export type InstanceReads = Pick<
  AnyTenantApp,
  | "checkLiveness"
  | "checkReadiness"
  | "auditLogOf"
  | "outboundCallsOf"
  | "pendingOutboundCallsOf"
  | "getExecution"
  | "listExecutions"
  | "getStatusHistory"
>;

export const instanceReadsOf = ({
  health,
  auditLog,
  outboundCalls,
  executionHistory,
  records,
}: InstanceSurface): InstanceReads => ({
  ...executionReadsOf(executionHistory),
  // #1341d: a thread's status history, oldest first — another tenant's thread has none
  // a thread id is a key's text, as at execute and cancel: refused, never echoed or read
  getStatusHistory: async (threadId, options) => {
    const tenantId = options?.tenantId ?? DEFAULT_TENANT_ID;
    return tenantRead(tenantId, () => {
      const rule = keyTextRuleOf(threadId);
      if (rule !== undefined) throw new ExecutionError.InvalidThreadId({ rule });
      return records.statusHistory(tenantId, threadId);
    });
  },
  // every call that returns a promise is async: a failure rejects, it is never thrown at the call (#1325)
  checkLiveness: async () => health.checkLiveness(),
  checkReadiness: async () => health.checkReadiness(),
  // #568, #580: a tenant id and a root execution id are keys' text here too — on UTF-8 stores
  // t\uD800 would read t\uFFFD's rows
  // rows written before #825 read with this version's names
  auditLogOf: async (tree) => treeRead(tree, () => auditLogIn(auditLog, tree)),
  // stored masked by the calling workflow's policies (#505); a business key by its handle (#508)
  outboundCallsOf: async ({ tenantId, rootExecutionId }) =>
    treeRead({ tenantId, rootExecutionId }, async () =>
      (await outboundCalls.findAllByTenantIdAndRootExecutionId(tenantId, rootExecutionId)).map(
        shownCallOf,
      ),
    ),
  // #825: a page at a time, by the store's cursor — never every pending call of a tenant at once
  pendingOutboundCallsOf: async (query) => pendingCallsOf(outboundCalls, query),
});

export { listPausesOf } from "./pause-masks.js";
