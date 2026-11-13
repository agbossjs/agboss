import { z } from "zod";
import { AGBossError } from "../core/errors.js";
import { PauseAnswerer } from "../channels/channel-role.decorator.js";
import { ComponentKind, type ComponentRecord } from "../flow/runtime/records.js";
import type { StepRecord } from "../flow/context/execution-context.js";
import type { PauseAnswerRecord } from "../flow/runtime/execution-record.js";
import { PauseResolution } from "./pause-record.js";

/** Whether a value is a `PauseAnswerer`. */
const isAnswerer = (value: unknown): value is PauseAnswerer =>
  Object.values(PauseAnswerer).some((one) => one === value);

const optionalText = z.string().optional();

/**
 * The join keys a stored pause keeps of its waiting step (#268 S93), read back with defaults: a
 * record stored before them names its agent only — an agent's record without hashes, iteration
 * unknown, no validation attempts.
 */

/** A component record as JSON stored it (`undefined` hashes are left out by JSON): every hash present. */
export const StoredComponent = z
  .object({
    name: z.string(),
    kind: z.enum(ComponentKind).default(ComponentKind.Agent),
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

/** What a refusal knows: the record, its ids and the failing fields — never a value. */
export interface StoredNamesUnreadableErrorOptions {
  readonly record: string;
  readonly ids: string;
  readonly fields: string;
  readonly cause?: unknown;
}

/**
 * One meaning per name (#934): a store reads what 0.1.0 wrote — a pause's `answeredBy` was who may
 * answer it, an answer's `answerer` and a log entry's `responder` were the person — and returns the
 * **normalised** value, never the input it parsed. The schemas of the stored shapes do it
 * (`PauseAnswerRecordSchema`, `StoredPause`, the history record's): parsing a value reads it, and a
 * value that is neither shape is refused with `StoredNamesUnreadableError`, naming the record's id
 * and the field — never a value. Nothing is migrated: writers write the new shape, readers take either.
 */
export class StoredNamesUnreadableError extends AGBossError {
  static override readonly code = "stored.unreadable" as const;
  declare readonly code: typeof StoredNamesUnreadableError.code;
  override name = "StoredNamesUnreadableError";
  /** What was stored: `pause`, `pause answer`, `execution history record`. */
  declare readonly record: string;
  /** The ids that name it (`pauseId p1, executionId run-1`); empty when none is readable. */
  declare readonly ids: string;
  /** The field paths that failed (`pauses.0.answerer`) — never a value. */
  declare readonly fields: string;

  constructor(options: StoredNamesUnreadableErrorOptions) {
    const { record, ids, fields, cause } = options;
    super(
      `a stored ${record} is not readable${ids === "" ? "" : ` (${ids})`}: the field(s) ${fields} missing or not what the framework wrote`,
      { cause },
    );
    Object.assign(this, { record, ids, fields });
  }
}

/** The ids that name a stored value in an error: its keys, never its content. */
const idsOf = (value: unknown, keys: readonly string[]): string =>
  keys
    .flatMap((key) => {
      const id: unknown =
        typeof value === "object" && value !== null ? Reflect.get(value, key) : "";
      return typeof id === "string" ? [`${key} ${id}`] : [];
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
  throw new StoredNamesUnreadableError({
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
 * A log entry as JSON stored it, in either shape (#934): 0.1.0's has no `answerer` — its `answeredBy`
 * is the kind, `responder` the person —, the new one has all three. Parsing it IS reading it: the
 * result is the new shape (`answerer` the kind, `answeredBy` the person, `responder` its deprecated
 * alias), and an entry that is neither — a kind that is none, a person that is no text — is
 * refused at its field, wherever it is nested (the history record's pauses and children's too).
 */
export const PauseAnswerRecordSchema = z
  .object({
    pauseId: optionalText,
    executionId: z.string(),
    step: StoredStep,
    role: z.string(),
    answerer: z.enum(PauseAnswerer).optional(),
    answeredBy: optionalText,
    responder: optionalText,
    resolution: z.enum(PauseResolution),
    askedAt: z.string(),
    resolvedAt: optionalText,
    decision: z.unknown().optional(),
    asked: z.unknown().optional(),
    isTaken: z.literal(false).optional(),
  })
  .transform((stored, context): PauseAnswerRecord => {
    const { answerer, answeredBy, responder } = stored;
    const kind = answerer ?? answeredBy;
    if (!isAnswerer(kind)) {
      context.addIssue({ code: "custom", path: ["answeredBy"], message: "no PauseAnswerer" });
      return z.NEVER;
    }
    const person = answerer === undefined ? responder : answeredBy;
    return {
      ...stored,
      pauseId: stored.pauseId,
      resolvedAt: stored.resolvedAt,
      decision: stored.decision,
      answerer: kind,
      answeredBy: person,
      responder: person,
    };
  });

/** A log entry from the parsed JSON a store kept: read in either shape, or unreadable (id, field). */
export const pauseAnswerRecordOfValue = (value: unknown): PauseAnswerRecord =>
  readStored(PauseAnswerRecordSchema, value, "pause answer", ["pauseId", "executionId"]);

/** A pause answer record as JSON stored it (`undefined` fields are left out by JSON: restored). */
export const pauseAnswerRecordOfJson = (text: string): PauseAnswerRecord =>
  pauseAnswerRecordOfValue(JSON.parse(text));
