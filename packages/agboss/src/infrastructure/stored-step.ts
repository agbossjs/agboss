import { StoreError } from "../core/error-families/store-errors.js";
import { z } from "zod";
import { parsedStoredJson } from "../core/stored-json.js";
import { ComponentKind, type ComponentRecord } from "../flow/runtime/records.js";
import type { StepRecord } from "../flow/context/execution-context.js";
import type { PauseAnswerRecord } from "../flow/runtime/execution-record.js";
import type { PauseActor } from "../channels/pause-contexts.js";
import { PauseResolution, pauseKeyOf, type PauseTrailRecord } from "./pause-record.js";
import { instantOf, instantOfOptional, trailEntryOf } from "./pause-record-instants.js";
import { PauseRespondent } from "../pause/respondent.js";

const optionalText = z.string().optional();

/** Who acted on a pause: an id, and the organisation it acts for. */
export const StoredActor = z.object({ id: z.string(), orgId: z.string().optional() });

/** The actor without the fields it does not have (`exactOptionalPropertyTypes`). */
export const actorOf = (stored: {
  readonly id: string;
  readonly orgId?: string | undefined;
}): PauseActor =>
  stored.orgId === undefined ? { id: stored.id } : { id: stored.id, orgId: stored.orgId };

/** One entry of a pause's chain of custody. */
export const StoredTrailEntry = z
  .object({
    action: z.enum(["opened", "reassigned", "timeout-changed", "escalated"]),
    at: z.string(),
    actor: StoredActor.optional(),
    target: z.string(),
    channel: z.string().optional(),
    assignees: z.array(z.string()).optional(),
    expiresAt: z.string().optional(),
    externalRef: z.string().optional(),
    reason: z.string().optional(),
  })
  .transform((stored): PauseTrailRecord => {
    const { actor, channel, assignees, expiresAt, externalRef, reason, ...rest } = stored;
    return {
      ...rest,
      ...(actor === undefined ? {} : { actor: actorOf(actor) }),
      ...(channel === undefined ? {} : { channel }),
      ...(assignees === undefined ? {} : { assignees }),
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(externalRef === undefined ? {} : { externalRef }),
      ...(reason === undefined ? {} : { reason }),
    };
  });

/** One entry of a chain of custody as a public record holds it: its times as dates (JSON kept them as ISO 8601 texts). */
export const StoredTrailEntryDated = StoredTrailEntry.transform(trailEntryOf);

/**
 * The join keys a stored pause keeps of its waiting step (#268 S93), read back with defaults: a
 * record stored before them names its agent only — an agent's record without hashes, iteration
 * unknown, no validation attempts.
 */

// The error and the text parser live in core (#1194: the turn store reads its texts with them and
// may import nothing above core); every importer of this module keeps its path.
export { parsedStoredJson };

/** A component record as JSON stored it (`undefined` hashes are left out by JSON): every hash present. */
export const StoredComponent = z
  .object({
    name: z.string(),
    kind: z.enum(ComponentKind),
    promptHash: optionalText,
    schemaHash: optionalText,
  })
  .transform((stored): ComponentRecord => ({
    name: stored.name,
    kind: stored.kind,
    promptHash: stored.promptHash,
    schemaHash: stored.schemaHash,
  }));

/** The step of a stored pause answer: every field present, `undefined` when it has none. */
const StoredStep = z
  .object({
    component: StoredComponent,
    nodeId: z.string(),
    visitNumber: z.number(),
    idempotencyKey: z.string(),
    callId: optionalText,
    itemIndex: z.number().optional(),
    copyNumber: z.number(),
    toolLoopIteration: z.number().optional(),
    validationAttempts: z.number().default(0),
  })
  .transform((stored): StepRecord => ({
    ...stored,
    callId: stored.callId,
    itemIndex: stored.itemIndex,
    toolLoopIteration: stored.toolLoopIteration,
  }));

/** The ids that name a stored value in an error: its keys, never its content. */
/** A pause id answers for the pause (a credential): it is named by the pause's key, never as it is (#1413 H2). */
const idTextOf = (key: string, id: string, value: unknown): string => {
  if (key !== "pauseId") return `${key} ${id}`;
  const tenant: unknown =
    typeof value === "object" && value !== null ? Reflect.get(value, "tenantId") : "";
  return `pause ${pauseKeyOf(typeof tenant === "string" ? tenant : "", id)}`;
};

const idsOf = (value: unknown, keys: readonly string[]): string =>
  keys
    .flatMap((key) => {
      const id: unknown =
        typeof value === "object" && value !== null ? Reflect.get(value, key) : "";
      return typeof id === "string" ? [idTextOf(key, id, value)] : [];
    })
    .join(", ");

/**
 * `value` read with `schema`, or unreadable: the error names what it was, the ids of the record
 * (`idKeys` among its keys) and the failing field paths — never a value, whose content is the
 * caller's (PII reaches the logs through a message). The schema's own error, which names paths and
 * expectations only, is the `cause`.
 */
export function readStored<S extends z.ZodType>(
  schema: S,
  value: unknown,
  what: string,
  idKeys: readonly string[],
): z.output<S> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  const ids = idsOf(value, idKeys);
  throw new StoreError.UnreadableRecord({
    record: what,
    ids,
    // what an error names instead of the value (#906 D4)
    fields: [...new Set(parsed.error.issues.map((i) => i.path.join(".") || "(the value)"))].join(
      ", ",
    ),
    cause: parsed.error,
  });
}

/**
 * A log entry as JSON stored it (#934): `respondent` the kind, `answeredBy` the person. Parsing it IS
 * reading it (0.1.0's `responder`, the person's alias, is refused: never read, never filled), and an entry
 * of any other shape — a kind that is none, a person that is no text — is refused at its field,
 * wherever it is nested (the history record's pauses and children's too).
 */
export const PauseAnswerRecordSchema = z
  .object({
    pauseId: optionalText,
    executionId: z.string(),
    step: StoredStep,
    target: z.string(),
    channel: z.string().optional(),
    role: z.never().optional(),
    respondent: z.enum(PauseRespondent),
    actor: StoredActor.optional(),
    // 0.1.0's names of `actor` and `input`: refused, never read
    answeredBy: z.never().optional(),
    responder: z.never().optional(),
    asked: z.never().optional(),
    resolution: z.enum(PauseResolution),
    askedAt: z.string().transform(instantOf),
    resolvedAt: optionalText.transform(instantOfOptional),
    decision: z.unknown().optional(),
    input: z.unknown().optional(),
    toolCall: z.unknown().optional(),
    assignees: z.array(z.string()).optional(),
    externalRef: z.string().optional(),
    trail: z.array(StoredTrailEntryDated),
    isTaken: z.literal(false).optional(),
  })
  .transform((stored): PauseAnswerRecord => ({
    ...stored,
    pauseId: stored.pauseId,
    resolvedAt: stored.resolvedAt,
    decision: stored.decision,
    input: stored.input,
    actor: stored.actor,
  }));

/** A log entry from the parsed JSON a store kept: read in the 0.1.1 shape, or unreadable (id, field). */
export const pauseAnswerRecordOfValue = (value: unknown): PauseAnswerRecord =>
  readStored(PauseAnswerRecordSchema, value, "pause answer", ["pauseId", "executionId"]);

/** A pause answer record as JSON stored it (`undefined` fields are left out by JSON: restored). */
export const pauseAnswerRecordOfJson = (text: string): PauseAnswerRecord =>
  pauseAnswerRecordOfValue(parsedStoredJson({ what: "pause answer", text }));
