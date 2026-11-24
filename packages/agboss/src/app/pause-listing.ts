import { DtoValidationError, type DtoIssue } from "../dto/errors.js";
import { tenantIdReason } from "../flow/context/context-values.js";
import type { ObservabilityMask } from "../pii/observability-mask.js";
import { PauseAnswerer } from "../channels/channel-role.decorator.js";
import type { PausedExecutionRepository } from "../infrastructure/paused-execution.repository.js";
import { closedAtOf, closedReasonOf } from "../infrastructure/pause-closing.js";
import {
  pauseAnswererOf,
  pauseKeyOf,
  PauseStatus,
  type PauseRecord,
} from "../infrastructure/pause-record.js";
import type { PauseFilter } from "../infrastructure/pause-notices.js";
import type { ListedPause, PausesPage } from "./types.js";

/**
 * `app.listPauses` (#943): a tenant's pauses a page at a time, through the store's keyset
 * (`findPageByTenantId`, #935 — a position in the store's insertion order, so inserts and closes
 * between pages skip and repeat nothing). A pause is shown as `result.pending` shows it (a
 * `Channel` pause's id stays with its channel, its `pauseKey` stands for it) with its `ask` masked
 * by its workflow's observability policies on top of the display mask it was stored with.
 */

/** What the listing is made of: the pause store, and the mask of the workflow a pause waits in. */
export interface PauseListing {
  readonly pauses: PausedExecutionRepository;
  /** The observability mask of the pause's workflow; `undefined`: nothing to mask with. */
  readonly maskOf: (pause: PauseRecord) => Promise<ObservabilityMask | undefined>;
}

const DEFAULT_PAGE = 100;
const MAX_PAGE = 1000;
const DTO = "PausesQuery";
const STATUSES: readonly string[] = Object.values(PauseStatus);

/** The query checked, as a store's filter and page. */
interface CheckedQuery {
  readonly tenantId: string;
  readonly filter: PauseFilter;
  readonly limit: number;
  readonly after: string | undefined;
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
  if (typeof tenantId !== "string") return issue("tenantId", "a tenant id is a text");
  const reason = tenantIdReason(tenantId);
  return reason === undefined ? [] : issue("tenantId", reason);
};
const checkRole: Check = (role) =>
  role === undefined || isKey(role)
    ? []
    : issue("role", "a role is the channel's name: a non-empty text");
const checkBefore: Check = (before) =>
  before === undefined || (before instanceof Date && !Number.isNaN(before.getTime()))
    ? []
    : issue("expiringBefore", "a valid Date");
const checkLimit: Check = (limit) =>
  typeof limit === "number" && Number.isInteger(limit) && limit >= 1 && limit <= MAX_PAGE
    ? []
    : issue("limit", `a page is a whole number of pauses from 1 to ${String(MAX_PAGE)}`);
const checkAfter: Check = (after) =>
  after === undefined || isKey(after)
    ? []
    : issue("after", "a cursor is the next of a page before: a non-empty text");

/** The query as an untyped (JS) caller may pass it, checked all at once: `dto.invalid` else. */
function checked(query: unknown): CheckedQuery {
  if (typeof query !== "object" || query === null)
    throw new DtoValidationError({
      dto: DTO,
      issues: issue("", "a query is an object with a tenantId"),
    });
  const issues: DtoIssue[] = [];
  const statuses = statusesOf(fieldOf(query, "status"), issues);
  const field = (key: string): unknown => fieldOf(query, key);
  const limit = field("limit") ?? DEFAULT_PAGE;
  issues.push(
    ...checkTenant(field("tenantId")),
    ...checkRole(field("role")),
    ...checkBefore(field("expiringBefore")),
    ...checkLimit(limit),
    ...checkAfter(field("after")),
  );
  if (issues.length > 0) throw new DtoValidationError({ dto: DTO, issues });
  const [role, before] = [
    field("role") as string | undefined,
    field("expiringBefore") as Date | undefined,
  ];
  return {
    tenantId: field("tenantId") as string,
    limit: limit as number,
    after: field("after") as string | undefined,
    filter: {
      statuses,
      ...(role === undefined ? {} : { channel: role }),
      ...(before === undefined ? {} : { expiresBefore: before }),
    },
  };
}

/** One pause as the listing shows it, what it asks and who has it through `mask`. */
async function listedOf(
  pause: PauseRecord,
  mask: ObservabilityMask | undefined,
): Promise<ListedPause> {
  const answerer = pauseAnswererOf(pause);
  return {
    // the rule of `result.pending` (AC3): a Channel pause's id stays with its channel
    ...(answerer === PauseAnswerer.ThreadOwner ? { pauseId: pause.pauseId } : {}),
    answerer,
    step: pause.step,
    channel: pause.channel,
    childExecutionId: pause.executionId === pause.rootExecutionId ? undefined : pause.executionId,
    itemIndex: pause.itemIndex,
    kind: pause.kind,
    ...(await shownOf(pause, mask)),
    pauseKey: pauseKeyOf(pause.tenantId, pause.pauseId),
    status: pause.status,
    rootExecutionId: pause.rootExecutionId,
    threadId: pause.threadId,
    askedAt: pause.askedAt,
    ...(pause.expiresAt === undefined ? {} : { expiresAt: pause.expiresAt }),
    ...closedPartOf(pause),
  };
}

/**
 * What a pause asks and who has it, as the listing shows it: the input, the tool call, the
 * assignees, the external reference and the chain of custody (a reassignment's reason included)
 * through the mask of the pause's own workflow.
 */
async function shownOf(
  pause: PauseRecord,
  mask: ObservabilityMask | undefined,
): Promise<Pick<ListedPause, "input" | "toolCall" | "assignees" | "externalRef" | "trail">> {
  const whole = {
    input: pause.input,
    toolCall: pause.toolCall,
    assignees: pause.assignees,
    externalRef: pause.externalRef,
    trail: pause.trail,
  };
  const shown = (mask === undefined ? whole : await mask.value(whole)) as typeof whole;
  return {
    input: shown.input,
    ...(shown.toolCall === undefined ? {} : { toolCall: shown.toolCall }),
    ...(shown.assignees === undefined ? {} : { assignees: shown.assignees }),
    ...(shown.externalRef === undefined ? {} : { externalRef: shown.externalRef }),
    trail: shown.trail,
  };
}

/** What only a closed pause has: why and when it closed, and who answered it. */
function closedPartOf(pause: PauseRecord): Pick<ListedPause, "reason" | "closedAt" | "actor"> {
  if (pause.status === PauseStatus.Pending) return {};
  const closedAt = closedAtOf(pause);
  const actor = pause.answer?.actor;
  return {
    reason: closedReasonOf(pause),
    ...(closedAt === undefined ? {} : { closedAt }),
    ...(actor === undefined ? {} : { actor }),
  };
}

/** `app.listPauses` over `listing`. */
export async function listPausesIn(listing: PauseListing, query: unknown): Promise<PausesPage> {
  const { tenantId, filter, limit, after } = checked(query);
  const page = await listing.pauses
    .findPageByTenantId(tenantId, filter, limit, after)
    .catch((error: unknown) => {
      // a cursor the store does not read as one of its own
      if (after === undefined || !(error instanceof TypeError || error instanceof RangeError))
        throw error;
      const reason = "a cursor is the next of a page before, as it was given";
      throw new DtoValidationError({ dto: DTO, issues: [{ path: "after", reason }], cause: error });
    });
  const pauses: ListedPause[] = [];
  for (const pause of page.pauses) pauses.push(await listedOf(pause, await listing.maskOf(pause)));
  return page.next === undefined ? { pauses } : { pauses, next: page.next };
}
