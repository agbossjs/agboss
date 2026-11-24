import type { ChannelSenderSend } from "../../channels/channel-sender.js";
import type { PausedExecutionRepository } from "../../infrastructure/paused-execution.repository.js";
import { AGBossError, type MessageErrorOptions } from "../../core/errors.js";
import {
  pauseKeyOf,
  type PauseAsk,
  type PauseKind,
  type PauseRecord,
} from "../../infrastructure/pause-record.js";
import { livePauseOf } from "../../run/waiting-pauses.js";

/** A reassigned pause's chain (#946): what its channel is sent, and the pause a step goes on with. */

/**
 * What a channel is sent for `pause`: its id and question — and, for a replacement a reassignment
 * made (#946), who it is for (`assignee`) and the pause it replaces (`replaces`); a first send has
 * neither. The one place the ask is built, for the step's own send and the re-send of a reassigned pause.
 */
export const askOfPause = (
  pause: PauseRecord,
): ChannelSenderSend & { readonly value: PauseAsk } => ({
  pauseId: pause.pauseId,
  value: pause.ask,
  ...(pause.assignee === undefined ? {} : { assignee: pause.assignee }),
  ...(pause.reassignedFrom === undefined ? {} : { replaces: { pauseId: pause.reassignedFrom } }),
});

/**
 * The pause live for the step's pause (#946): a reassigned approval's step finds its first pause by
 * the step key — `Cancelled / Reassigned` — and goes on with the replacement, which is `Pending`
 * (it interrupts again at it) or answered (it takes the answer). The record itself otherwise.
 */
export async function livePauseAfter(
  pauses: PausedExecutionRepository,
  pause: PauseRecord,
): Promise<PauseRecord> {
  if (pause.reassignedTo === undefined) return pause;
  const records = await pauses.findAllByTenantIdAndRootExecutionId(
    pause.tenantId,
    pause.rootExecutionId,
  );
  return (
    livePauseOf(new Map(records.map((record) => [record.pauseId, record])), pause.pauseId) ?? pause
  );
}

/**
 * The step key found a pause whose question is not the step's (#946): a step key names no question
 * by itself — a tool call id a model chose may look like a replacement's `~r<n>` — so a record found
 * by it is reused only for the question it was made for. Refused, never answered: its answer would
 * be another question's. The message names the pause by its key, never its id.
 */
export class PauseStepKeyMismatchError extends AGBossError {
  static override readonly code = "pause.step-key-mismatch" as const;
  declare readonly code: typeof PauseStepKeyMismatchError.code;
  override name = "PauseStepKeyMismatchError";

  constructor(options: MessageErrorOptions) {
    super(options.message, options);
  }
}

/** A value as text with its object keys in order: two asks are the same when this text is. */
function canonicalText(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalText).join(",")}]`;
  if (typeof value !== "object" || value === null) return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalText(item)}`).join(",")}}`;
}

/** Throws unless the pause found by the step's key asks the question the step asks (its kind and its ask). */
export function assertSameQuestion(
  found: PauseRecord,
  question: { readonly kind: PauseKind; readonly ask: PauseAsk },
): void {
  if (found.kind === question.kind && canonicalText(found.ask) === canonicalText(question.ask))
    return;
  throw new PauseStepKeyMismatchError({
    message: `pause ${pauseKeyOf(found.tenantId, found.pauseId)} was found by a step key but asks another question: it is not reused`,
  });
}
