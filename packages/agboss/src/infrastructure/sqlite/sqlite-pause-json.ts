import { z } from "zod";
import { PauseAnswerer } from "../../channels/channel-role.decorator.js";
import {
  PauseResolution,
  PauseStatus,
  type PauseAnswer,
  type PauseRecord,
} from "../pause-record.js";

/**
 * A pause row of `SqlitePausedExecutionRepository` read and written (#267 S35, S107): its columns
 * and the JSON it keeps, each validated on the way out; a row stored by an earlier version reads
 * with defaults (no copy number: the first copy; no resolution column: its status says).
 */

/** What a pause row keeps as JSON: everything but its id, status, flag and resolution. */
const StoredPause = z.object({
  threadId: z.string(),
  executionId: z.string(),
  workflow: z.string(),
  nodeId: z.string(),
  visitNumber: z.number(),
  itemIndex: z.number().optional(),
  // a pause stored before #267 S107 kept neither: the first copy, asked at an unknown time
  copyNumber: z.number().default(1),
  askedAt: z.string().default(""),
  agent: z.string(),
  channel: z.string(),
  answeredBy: z.enum(PauseAnswerer),
  ask: z.object({
    callId: z.string(),
    tool: z.string(),
    arguments: z.record(z.string(), z.unknown()),
    summary: z.string(),
  }),
});

const PauseRow = z.object({
  tenant_id: z.string(),
  pause_id: z.string(),
  step_key: z.string(),
  root_execution_id: z.string(),
  status: z.enum(PauseStatus),
  is_sent: z.number(),
  pause: z.string(),
  answer: z.string().nullable(),
  resolution: z.enum(PauseResolution).nullable(),
  resolved_at: z.string().nullable(),
});

const StoredUsage = z.object({
  caller: z.string(),
  model: z.string(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  costUsd: z.number(),
  costSource: z.enum(["api", "price-table", "tool"]),
});

const StoredAnswer = z.object({
  decision: z.unknown(),
  answerer: z.string().optional(),
  usage: z.array(StoredUsage).optional(),
});

/** How a row was resolved: its column, else (a row stored before #267 S107) its status says. */
function resolutionOf(r: z.infer<typeof PauseRow>): PauseResolution | undefined {
  if (r.resolution !== null) return r.resolution;
  if (r.status === PauseStatus.Cancelled) return PauseResolution.Cancelled;
  return r.answer === null ? undefined : PauseResolution.Replied;
}

/** The answer a row keeps, as JSON. */
function answerOf(text: string): PauseAnswer {
  const { decision, answerer, usage } = StoredAnswer.parse(JSON.parse(text));
  return { decision, answerer, ...(usage === undefined ? {} : { usage }) };
}

/** A row as the record it keeps. */
export function toPauseRecord(row: unknown): PauseRecord {
  const r = PauseRow.parse(row);
  const { itemIndex, ...stored } = StoredPause.parse(JSON.parse(r.pause));
  const pause: PauseRecord = {
    ...stored,
    itemIndex,
    tenantId: r.tenant_id,
    pauseId: r.pause_id,
    stepKey: r.step_key,
    rootExecutionId: r.root_execution_id,
    status: r.status,
    isSent: r.is_sent === 1,
  };
  const resolution = resolutionOf(r);
  return {
    ...pause,
    ...(r.answer === null ? {} : { answer: answerOf(r.answer) }),
    ...(resolution === undefined ? {} : { resolution }),
    ...(r.resolved_at === null ? {} : { resolvedAt: r.resolved_at }),
  };
}

/** What a row keeps of a record as JSON. */
export const storedOf = (pause: PauseRecord): string =>
  JSON.stringify({
    threadId: pause.threadId,
    executionId: pause.executionId,
    workflow: pause.workflow,
    nodeId: pause.nodeId,
    visitNumber: pause.visitNumber,
    itemIndex: pause.itemIndex,
    copyNumber: pause.copyNumber,
    askedAt: pause.askedAt,
    agent: pause.agent,
    channel: pause.channel,
    answeredBy: pause.answeredBy,
    ask: pause.ask,
  });
