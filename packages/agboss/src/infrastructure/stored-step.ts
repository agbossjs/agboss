import { z } from "zod";
import { CostSource } from "../finops/usage.js";
import { ComponentKind, type ComponentRecord } from "../flow/runtime/records.js";
import type { PauseAnswer, PauseAsk, QuestionAsk } from "./pause-record.js";

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
  answerer: z.string().optional(),
  usage: z.array(StoredUsage).optional(),
});

/** The answer a row keeps, as JSON. */
export function answerOf(text: string): PauseAnswer {
  const { decision, answerer, usage } = StoredAnswer.parse(JSON.parse(text));
  return { decision, answerer, ...(usage === undefined ? {} : { usage }) };
}
