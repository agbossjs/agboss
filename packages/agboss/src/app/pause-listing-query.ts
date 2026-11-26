import { type DtoIssue, invalidDto } from "../dto/errors.js";
import { tenantIdReason } from "../flow/context/context-values.js";
import { PauseStatus } from "../infrastructure/pause-record.js";
import type { PauseFilter } from "../infrastructure/pause-notices.js";
import { targetNameOf } from "../channels/pause-targets.js";
import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";

/**
 * The query of `app.listPauses` (#943, #1307e) as an untyped (JS) caller may pass it, checked all
 * at once and made the store's filter and page: one tenant (default `"default"`) or every tenant,
 * and a field the query does not have refused, never ignored.
 */

export const QUERY_DTO = "PausesQuery";
const DEFAULT_PAGE = 100;
const MAX_PAGE = 1000;
const STATUSES: readonly string[] = Object.values(PauseStatus);

/** The query checked, as a store's filter and page. */
export interface CheckedQuery {
  /** `undefined`: every tenant's (`allTenants`). */
  readonly tenantId: string | undefined;
  readonly filter: PauseFilter;
  readonly limit: number;
  readonly cursor: string | undefined;
  /** Whether a delegated pause shows its id (the right to answer it). */
  readonly includePauseIds: boolean;
}

const fieldOf = (query: object, key: string): unknown => Reflect.get(query, key) as unknown;

function statusesOf(status: unknown, issues: DtoIssue[]): readonly PauseStatus[] {
  if (status === undefined) return [PauseStatus.Pending];
  const given: readonly unknown[] = Array.isArray(status) ? (status as unknown[]) : [status];
  const unknown = given.filter((one) => typeof one !== "string" || !STATUSES.includes(one));
  if (given.length === 0 || unknown.length > 0)
    issues.push({
      path: "status",
      reason: `a status, or a non-empty list of them, from ${STATUSES.join(", ")}`,
    });
  return [...new Set(given as PauseStatus[])];
}

const isKey = (value: unknown): value is string => typeof value === "string" && value !== "";

/** A field's problem, as an issue list (empty: none). */
type Check = (value: unknown) => readonly DtoIssue[];

const issue = (path: string, reason: string): readonly DtoIssue[] => [{ path, reason }];

const checkTenant: Check = (tenantId) => {
  if (tenantId === undefined) return [];
  if (typeof tenantId !== "string") return issue("tenantId", "a tenant id is a text");
  const reason = tenantIdReason(tenantId);
  return reason === undefined ? [] : issue("tenantId", reason);
};
/** The scope: one tenant (default: `"default"`) or `allTenants: true`, never both. */
const checkScope: Check = (query) => {
  const { tenantId, allTenants } = query as { tenantId?: unknown; allTenants?: unknown };
  if (allTenants === undefined || allTenants === false) return checkTenant(tenantId);
  if (allTenants !== true) return issue("allTenants", "true, or left out");
  return tenantId === undefined
    ? []
    : issue("allTenants", "allTenants and tenantId exclude each other");
};
const checkText =
  (path: string, what: string): Check =>
  (value) =>
    value === undefined || isKey(value) ? [] : issue(path, what);
const checkTarget: Check = (target) =>
  typeof target === "function"
    ? []
    : checkText("target", "a target is a @ToolApproval / @ExternalTask class or its name")(target);
const checkBefore: Check = (before) => {
  if (before === undefined) return [];
  const date =
    before instanceof Date ? before : typeof before === "string" ? new Date(before) : NaN;
  return date instanceof Date && !Number.isNaN(date.getTime())
    ? []
    : issue("expiringBefore", "a valid Date, or an ISO 8601 text");
};
const checkLimit: Check = (limit) =>
  typeof limit === "number" && Number.isInteger(limit) && limit >= 1 && limit <= MAX_PAGE
    ? []
    : issue("limit", `a page is a whole number of pauses from 1 to ${String(MAX_PAGE)}`);
const checkCursor = checkText(
  "cursor",
  "a cursor is the nextCursor of a page before: a non-empty text",
);
const checkIncluded: Check = (value) =>
  value === undefined || typeof value === "boolean"
    ? []
    : issue("includePauseIds", "true or false");

/** A target given as a class, as its name; a name as itself (a class that is no target is `ConfigError.Component`). */
const targetOf = (target: unknown): string | undefined =>
  typeof target === "function" ? targetNameOf(target as never) : (target as string | undefined);

const FIELDS: ReadonlySet<string> = new Set([
  "tenantId",
  "allTenants",
  "status",
  "target",
  "assignee",
  "externalRef",
  "expiringBefore",
  "includePauseIds",
  "limit",
  "cursor",
]);

/** A field the query does not have (a retired `after`, a `role`) is refused, never ignored: a page loop would go on forever on it. */
const checkFields = (query: object): readonly DtoIssue[] =>
  Object.keys(query)
    .filter((key) => !FIELDS.has(key))
    .map((key) => ({ path: key, reason: "not a field of a pauses query" }));

const checkAssignee = checkText("assignee", "an assignee is a non-empty text");
const checkReference = checkText("externalRef", "an external reference is a non-empty text");

/** Every problem of the query's fields. */
const problemsOf = (query: object, limit: unknown): readonly DtoIssue[] => {
  const field = (key: string): unknown => fieldOf(query, key);
  return [
    ...checkFields(query),
    ...checkScope(query),
    ...checkTarget(field("target")),
    ...checkAssignee(field("assignee")),
    ...checkReference(field("externalRef")),
    ...checkBefore(field("expiringBefore")),
    ...checkLimit(limit),
    ...checkCursor(field("cursor")),
    ...checkIncluded(field("includePauseIds")),
  ];
};

/** The store's filter of a checked query. */
function filterOf(query: object, statuses: readonly PauseStatus[]): PauseFilter {
  const field = (key: string): unknown => fieldOf(query, key);
  const target = targetOf(field("target"));
  const before = field("expiringBefore") as Date | string | undefined;
  const [assignee, externalRef] = [field("assignee"), field("externalRef")] as (
    string | undefined
  )[];
  return {
    statuses,
    ...(target === undefined ? {} : { target }),
    ...(before === undefined ? {} : { expiresBefore: new Date(before) }),
    ...(assignee === undefined ? {} : { assignee }),
    ...(externalRef === undefined ? {} : { externalRef }),
  };
}

/** The query as an untyped (JS) caller may pass it, checked all at once: `validation.dto-invalid` else. */
export function checked(query: unknown): CheckedQuery {
  const given = query ?? {};
  if (typeof given !== "object")
    throw invalidDto({ dto: QUERY_DTO, issues: issue("", "a query is an object") });
  const issues: DtoIssue[] = [];
  const statuses = statusesOf(fieldOf(given, "status"), issues);
  const limit = fieldOf(given, "limit") ?? DEFAULT_PAGE;
  issues.push(...problemsOf(given, limit));
  if (issues.length > 0) throw invalidDto({ dto: QUERY_DTO, issues });
  const { tenantId, allTenants, cursor, includePauseIds } = given as Record<string, unknown>;
  return {
    tenantId:
      allTenants === true ? undefined : ((tenantId as string | undefined) ?? DEFAULT_TENANT_ID),
    limit: limit as number,
    cursor: cursor as string | undefined,
    includePauseIds: includePauseIds === true,
    filter: filterOf(given, statuses),
  };
}
