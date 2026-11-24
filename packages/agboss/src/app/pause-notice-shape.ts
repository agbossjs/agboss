import type { PauseActor, PauseToolCallSummary } from "../channels/pause-contexts.js";
import type { PauseNotice } from "../infrastructure/pause-notices.js";
import type { PauseRecord } from "../infrastructure/pause-record.js";
import type { PauseListenerEventBase } from "../pause/notice-events.js";

/** What an event says of a pause's question and custody: split from `pause-notices.ts`. */

/** What a pause asks as its channel is told: the input and, for an approval, the tool call. */
export const askedOf = (
  pause: PauseRecord,
): {
  readonly input: Readonly<Record<string, unknown>>;
  readonly toolCall?: PauseToolCallSummary;
} => ({
  input: pause.input,
  ...(pause.toolCall === undefined ? {} : { toolCall: pause.toolCall }),
});

/**
 * What a pause asks and who has it, as a listener is told: every text through the mask of the
 * pause's own workflow (its PII policy) — the input, the tool call, the assignees, the external
 * reference and the whole chain of custody, a reassignment's reason included.
 */
export async function listenedOf(
  pause: PauseRecord,
  masked: (value: unknown) => Promise<unknown>,
): Promise<
  Pick<PauseListenerEventBase, "input" | "toolCall" | "assignees" | "externalRef" | "trail">
> {
  const shown = (await masked({
    input: pause.input,
    toolCall: pause.toolCall,
    assignees: pause.assignees,
    externalRef: pause.externalRef,
    trail: pause.trail,
  })) as Pick<PauseListenerEventBase, "input" | "toolCall" | "assignees" | "externalRef" | "trail">;
  return {
    input: shown.input,
    ...(shown.toolCall === undefined ? {} : { toolCall: shown.toolCall }),
    ...(shown.assignees === undefined ? {} : { assignees: shown.assignees }),
    ...(shown.externalRef === undefined ? {} : { externalRef: shown.externalRef }),
    trail: shown.trail,
  };
}

/** The actor as a listener is told: its texts through the pause's own workflow's mask. */
export const maskedActor = async (
  sources: { readonly masked: (value: unknown) => Promise<unknown> },
  actor: PauseActor,
): Promise<PauseActor> => (await sources.masked(actor)) as PauseActor;

/** The deadline a notice names; a notice of a deadline always carries it (the store writes it). */
export function deadlineOf(notice: PauseNotice): string {
  if (notice.expiresAt === undefined)
    throw new TypeError(`a ${notice.kind} notice names its deadline`);
  return notice.expiresAt;
}

/** The deadline an extension moved from. */
export function previousDeadlineOf(notice: PauseNotice): string {
  if (notice.previousExpiresAt === undefined)
    throw new TypeError("an extended notice names the deadline it moved from");
  return notice.previousExpiresAt;
}
