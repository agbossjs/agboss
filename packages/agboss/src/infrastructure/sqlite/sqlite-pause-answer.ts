import { z } from "zod";
import type { PauseAnswer } from "../pause-record.js";

/** The answer a pause row keeps as JSON (#267 S107): the decision, who gave it, what reading it cost. */

const StoredUsage = z.object({
  caller: z.string(),
  model: z.string(),
  ...{ inputTokens: z.number(), outputTokens: z.number() },
  ...{ cacheReadTokens: z.number(), cacheWriteTokens: z.number() },
  costUsd: z.number(),
  costSource: z.enum(["api", "price-table", "tool"]),
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
