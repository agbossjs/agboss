import { z } from "zod";
import { PauseAnswerer } from "../channels/channel-role.decorator.js";
import type { ChildExecutionRecord } from "../flow/runtime/child-records.js";
import type { PauseAnswerRecord } from "../flow/runtime/execution-record.js";
import type { ExecutionHistoryRecord } from "./execution-history.repository.js";
import { CostSource } from "../finops/usage.js";
import { ComponentKind, type ComponentRecord } from "../flow/runtime/records.js";
import type { PauseAnswer, PauseAsk, PauseRecord, QuestionAsk } from "./pause-record.js";

/**
 * The join keys a stored pause keeps of its waiting step (#268 S93), read back with defaults: a
 * record stored before them names its agent only — an agent's record without hashes, iteration
 * unknown, no validation attempts.
 */

const optionalText = z.string().optional();

/** A component record as JSON stored it (`undefined` hashes are left out by JSON). */
export const StoredComponent = z.object({
  name: z.string(),
  kind: z.enum(ComponentKind).default(ComponentKind.Agent),
  promptHash: optionalText,
  schemaHash: optionalText,
});

/** A stored component as its record: every hash present, `undefined` when it has none. */
export const componentOfStored = (stored: z.infer<typeof StoredComponent>): ComponentRecord => ({
  name: stored.name,
  kind: stored.kind,
  promptHash: stored.promptHash,
  schemaHash: stored.schemaHash,
});

/** What a stored pause keeps of its step's loop (both absent before #268 S93). */
export const StoredLoopProgress = {
  component: StoredComponent.optional(),
  toolLoopIteration: z.number().optional(),
  validationAttempts: z.number().optional(),
};

/** The tool call an approval's pause asks about. */
const StoredApprovalAsk = z.object({
  callId: z.string(),
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  summary: z.string(),
});

/** #746: a question role's ask is its own DTO, kept as written; an approval's is the tool call. */
export const askOfStored = (
  ask: Readonly<Record<string, unknown>>,
  isQuestion: boolean,
): PauseAsk => (isQuestion ? (ask as QuestionAsk) : StoredApprovalAsk.parse(ask));

/** The answer a pause row keeps as JSON (#267 S107): the decision, who gave it, what reading it cost. */
const StoredUsage = z.object({
  caller: z.string(),
  model: z.string(),
  ...{ inputTokens: z.number(), outputTokens: z.number() },
  ...{ cacheReadTokens: z.number(), cacheWriteTokens: z.number() },
  costUsd: z.number(),
  costSource: z.enum(CostSource),
  servedBy: z.string().optional(),
});

const StoredAnswer = z.object({
  decision: z.unknown(),
  // 0.1.0 kept the person as `answerer` (#934)
  answerer: z.string().optional(),
  answeredBy: z.string().optional(),
  usage: z.array(StoredUsage).optional(),
});

/** The answer a row keeps, as JSON. */
export function answerOf(text: string): PauseAnswer {
  const { decision, answerer, answeredBy, usage } = StoredAnswer.parse(JSON.parse(text));
  return pauseAnswerOfStored({
    decision,
    answerer,
    answeredBy,
    ...(usage === undefined ? {} : { usage }),
  });
}

/**
 * One meaning per name (#934): a store reads what 0.1.0 wrote — a pause's `answeredBy` was who may
 * answer it, an answer's `answerer` and a log entry's `responder` were the person — and returns the
 * **normalised** value, never the input it parsed. Each function takes what the store's own check of
 * the stored JSON established (either shape) and builds the new shape from those fields; a field that
 * is neither shape's throws `StoredNamesUnreadableError`, naming the id and the field only. Values
 * already in the new shape pass through, the new key winning when both are there. Nothing is migrated:
 * writers write the new shape, readers take either.
 */

/** A stored value that is neither shape: names the record's id and the field, never a value. */
export class StoredNamesUnreadableError extends Error {
  override name = "StoredNamesUnreadableError";
}

const isAnswerer = (value: unknown): value is PauseAnswerer =>
  Object.values(PauseAnswerer).some((one) => one === value);

const unreadable = (record: string, id: string, field: string): StoredNamesUnreadableError =>
  new StoredNamesUnreadableError(`a stored ${record} (${id}) has no readable ${field}`);

/** A pause's answer, 0.1.0's (`answerer`: the person) or the new (`answeredBy`). */
export type StoredPauseAnswer = Omit<PauseAnswer, "answeredBy"> & {
  readonly answeredBy?: string | undefined;
  readonly answerer?: string | undefined;
};

/** A pause record, 0.1.0's (`answeredBy`: the kind) or the new (`answerer`). */
export type StoredPause = Omit<PauseRecord, "answerer" | "answeredBy" | "answer"> & {
  readonly answerer?: PauseAnswerer | undefined;
  readonly answeredBy?: PauseAnswerer | undefined;
  readonly answer?: StoredPauseAnswer | undefined;
};

/** A log entry, 0.1.0's (`answeredBy`: the kind, `responder`) or the new (`answerer`, `answeredBy`). */
export type StoredAnswerRecord = Omit<
  PauseAnswerRecord,
  "answerer" | "answeredBy" | "responder"
> & {
  readonly answerer?: PauseAnswerer | undefined;
  readonly answeredBy?: string | undefined;
  readonly responder?: string | undefined;
};

/** A child of a kept record, its pauses in either shape. */
export type StoredChild = Omit<ChildExecutionRecord, "pauses" | "children"> & {
  readonly pauses: readonly StoredAnswerRecord[];
  readonly children: readonly StoredChild[];
};

/** A kept history record, its pauses and its children's in either shape. */
export type StoredHistoryRecord = Omit<ExecutionHistoryRecord, "pauses" | "children"> & {
  readonly pauses: readonly StoredAnswerRecord[];
  readonly children: readonly StoredChild[];
};

/**
 * Who may answer a pause: its `answerer`, else the `answeredBy` of a record a store of yours wrote
 * the 0.1.0 way (the deprecated alias of `PauseRecord`).
 */
export function pauseAnswererOf(pause: {
  readonly answerer?: PauseAnswerer | undefined;
  readonly answeredBy?: PauseAnswerer | undefined;
}): PauseAnswerer {
  const answerer = pause.answerer ?? pause.answeredBy;
  if (answerer === undefined) throw new TypeError("a pause record names who may answer it");
  return answerer;
}

/** The answer alone (SQLite's `pauses.answer`): 0.1.0's `answerer` — the person — is `answeredBy`. */
export function pauseAnswerOfStored(stored: StoredPauseAnswer): PauseAnswer {
  const { answerer, answeredBy, ...rest } = stored;
  return { ...rest, answeredBy: answeredBy ?? answerer };
}

/** A pause record: one without `answerer` takes `answeredBy` (the kind); its answer is normalised. */
export function pauseRecordOfStored(stored: StoredPause): PauseRecord {
  const { answerer, answeredBy, answer, ...rest } = stored;
  const kind = answerer ?? answeredBy;
  if (kind === undefined) throw unreadable("pause", stored.pauseId, "answerer");
  return {
    ...rest,
    answerer: kind,
    ...(answer === undefined ? {} : { answer: pauseAnswerOfStored(answer) }),
  };
}

/**
 * An answer-log entry: one without `answerer` is the 0.1.0 shape (`answeredBy` the kind, `responder`
 * the person), mapped to `answerer` = the kind, `answeredBy` = the person; `responder` stays as the
 * deprecated alias.
 */
export function pauseAnswerRecordOfStored(stored: StoredAnswerRecord): PauseAnswerRecord {
  const { answerer, answeredBy, responder, ...rest } = stored;
  if (answerer !== undefined) return { ...rest, answerer, answeredBy, responder: answeredBy };
  if (!isAnswerer(answeredBy)) throw unreadable("pause answer", stored.executionId, "answeredBy");
  return { ...rest, answerer: answeredBy, answeredBy: responder, responder };
}

/** A stored list mapped, or the record is unreadable at `field` (a store hands over JSON it parsed). */
function mapped<T, R>(
  list: readonly T[] | undefined,
  at: { readonly id: string; readonly field: string },
  convert: (item: T) => R,
): R[] {
  if (!Array.isArray(list)) throw unreadable("execution history record", at.id, at.field);
  return list.map(convert);
}

function childOfStored(stored: StoredChild): ChildExecutionRecord {
  const id = stored.executionId;
  return {
    ...stored,
    pauses: mapped(stored.pauses, { id, field: "children.pauses" }, pauseAnswerRecordOfStored),
    children: mapped(stored.children, { id, field: "children.children" }, childOfStored),
  };
}

/** A kept `ExecutionHistoryRecord` (#401): every `pauses` of it and of its children, normalised. */
export function executionHistoryRecordOfStored(
  stored: StoredHistoryRecord,
): ExecutionHistoryRecord {
  const id = stored.executionId;
  return {
    ...stored,
    pauses: mapped(stored.pauses, { id, field: "pauses" }, pauseAnswerRecordOfStored),
    children: mapped(stored.children, { id, field: "children" }, childOfStored),
  };
}

/** The failing field paths of a refused value: what an error names instead of the value (#906 D4). */
export const paths = (error: z.ZodError): string =>
  error.issues.map((issue) => issue.path.join(".") || "(root)").join(", ");

/** The step of a stored pause answer. */
export const StoredStep = z.object({
  component: StoredComponent,
  nodeId: z.string(),
  visitNumber: z.number(),
  idempotencyKey: z.string(),
  callId: optionalText,
  itemIndex: z.number().optional(),
  copyNumber: z.number(),
  toolLoopIteration: z.number().optional(),
  validationAttempts: z.number().default(0),
});
