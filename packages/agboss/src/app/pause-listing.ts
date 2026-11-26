import { invalidDto } from "../dto/errors.js";
import type { ObservabilityMask } from "../pii/observability-mask.js";
import type { PausedExecutionRepository } from "../infrastructure/paused-execution.repository.js";
import { closedAtOf, closedReasonOf } from "../infrastructure/pause-closing.js";
import {
  pauseRespondentOf,
  pauseKeyOf,
  PauseStatus,
  type PauseRecord,
} from "../infrastructure/pause-record.js";
import type { Page } from "./page.js";
import type { ListedPause } from "./types.js";
import { checked, QUERY_DTO } from "./pause-listing-query.js";
import { PauseRespondent } from "../pause/respondent.js";

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

/** One pause as the listing shows it, what it asks and who has it through `mask`. */
async function listedOf(
  pause: PauseRecord,
  mask: ObservabilityMask | undefined,
  includePauseIds: boolean,
): Promise<ListedPause> {
  const respondent = pauseRespondentOf(pause);
  return {
    // the rule of `result.pending` (AC3): a Channel pause's id stays with its channel, unless the
    // caller asked for ids (#1307e: an operator who may answer)
    ...(respondent === PauseRespondent.Owner || includePauseIds ? { pauseId: pause.pauseId } : {}),
    respondent,
    step: pause.step,
    target: pause.target,
    ...(pause.channel === undefined ? {} : { channel: pause.channel }),
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
export async function listPausesIn(
  listing: PauseListing,
  query: unknown,
): Promise<Page<ListedPause>> {
  const { tenantId, filter, limit, cursor, includePauseIds } = checked(query);
  const read =
    tenantId === undefined
      ? listing.pauses.findPageOfAllTenants(filter, limit, cursor)
      : listing.pauses.findPageByTenantId(tenantId, filter, limit, cursor);
  const page = await read.catch((error: unknown) => {
    // a cursor the store does not read as one of its own
    if (cursor === undefined || !(error instanceof TypeError || error instanceof RangeError))
      throw error;
    const reason = "a cursor is the nextCursor of a page before, as it was given";
    throw invalidDto({ dto: QUERY_DTO, issues: [{ path: "cursor", reason }], cause: error });
  });
  const items: ListedPause[] = [];
  for (const pause of page.pauses)
    items.push(await listedOf(pause, await listing.maskOf(pause), includePauseIds));
  return page.next === undefined ? { items } : { items, nextCursor: page.next };
}
