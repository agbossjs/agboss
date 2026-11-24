import { z } from "zod";
import { CostSource } from "../finops/usage.js";
import { PauseAnswerer } from "../channels/channel-role.decorator.js";
import {
  ExpiryProblem,
  PauseExpiryBound,
  PauseKind,
  PauseResolution,
  PauseStatus,
  questionAskOf,
  type PauseAnswer,
  type PauseAsk,
  type PauseRecord,
} from "./pause-record.js";
import { storedUsd } from "../finops/cost-report.js";
import { readStored, StoredComponent } from "./stored-step.js";

/**
 * A pause as a store keeps it as JSON (#934): every field of `PauseRecord` in the 0.1.1 shape, with
 * the answer it embeds checked inside. A row of any other shape (an old name, a missing field) is
 * `StoredNamesUnreadableError`.
 */

/** What reading a reply cost (#267 S107): the fields the ledger is written from, the rest as written. */
const StoredUsage = z.looseObject({
  caller: z.string(),
  model: z.string(),
  ...{ inputTokens: z.number(), outputTokens: z.number() },
  ...{ cacheReadTokens: z.number(), cacheWriteTokens: z.number() },
  costUsd: storedUsd,
  costSource: z.enum(CostSource),
  servedBy: z.string().optional(),
  provider: z.string(),
});

/** The answer a pause keeps (#267 S107): the decision, who gave it, its cost. */
export const StoredAnswer = z
  .object({
    decision: z.unknown(),
    answeredBy: z.string().optional(),
    // 0.1.0's name of `answeredBy` (the person): refused, never read
    answerer: z.never().optional(),
    // #1197: the channel's own decision; `false` is no marker
    byChannel: z.boolean().optional(),
    usage: z.array(StoredUsage).optional(),
  })
  .transform((stored): PauseAnswer => ({
    decision: stored.decision,
    answeredBy: stored.answeredBy,
    ...(stored.byChannel === true ? { byChannel: true as const } : {}),
    ...(stored.usage === undefined ? {} : { usage: stored.usage }),
  }));
/** The tool call an approval's pause asks about. */
export const StoredApprovalAsk = z.object({
  callId: z.string(),
  tool: z.string(),
  arguments: z.record(z.string(), z.unknown()),
  summary: z.string(),
});

/** #746: a question role's ask is its own DTO, as written; an approval's is the tool call. */
const askOfStored = (
  kind: PauseKind,
  ask: Readonly<Record<string, unknown>>,
): PauseAsk | undefined => {
  if (kind === PauseKind.Question) return questionAskOf(ask);
  const approval = StoredApprovalAsk.safeParse(ask);
  return approval.success ? approval.data : undefined;
};

/** A pause record as JSON stored it; parsing it reads it. */
export const StoredPause = z
  .object({
    threadId: z.string(),
    executionId: z.string(),
    workflow: z.string(),
    nodeId: z.string(),
    visitNumber: z.number(),
    itemIndex: z.number().optional(),
    copyNumber: z.number(),
    askedAt: z.string(),
    kind: z.enum(PauseKind),
    step: z.string(),
    component: StoredComponent.optional(),
    toolLoopIteration: z.number().optional(),
    validationAttempts: z.number().optional(),
    channel: z.string(),
    // a pause stored before #337 has none: its own step's key is its only branch key
    branchKeys: z.array(z.string()).optional(),
    answerer: z.enum(PauseAnswerer),
    // 0.1.0's name of `answerer` (who may answer): refused, never read, never filled from 0.1.1
    answeredBy: z.never().optional(),
    // an approval's tool call, or a question role's own ask (#659, #712, #746): `kind` says
    ask: z.record(z.string(), z.unknown()),
    pauseId: z.string(),
    tenantId: z.string(),
    rootExecutionId: z.string(),
    stepKey: z.string(),
    status: z.enum(PauseStatus),
    isSent: z.boolean(),
    resolution: z.enum(PauseResolution).optional(),
    resolvedAt: z.string().optional(),
    // #910: the deadline, when to remind, its bound, where it may not pass, why an expiry fell back to fail
    expiresAt: z.string().optional(),
    remindAt: z.string().optional(),
    expiryBound: z.enum(PauseExpiryBound).optional(),
    boundAt: z.string().optional(),
    expiryProblem: z.enum(ExpiryProblem).optional(),
    // #935: how and when the answer first closed the pause, kept past an untaken close
    closedFirst: z
      .object({ resolution: z.enum(PauseResolution), resolvedAt: z.string() })
      .optional(),
    // #946: who a reassigned pause is for, the pause it replaced, the pause that replaced it
    assignee: z.string().optional(),
    reassignedTo: z.string().optional(),
    reassignedFrom: z.string().optional(),
    answer: StoredAnswer.optional(),
  })
  .transform((stored, context): PauseRecord => {
    const { branchKeys, itemIndex, ask, ...rest } = stored;
    const asked = askOfStored(stored.kind, ask);
    if (asked === undefined) {
      context.addIssue({
        code: "custom",
        path: ["ask"],
        message: "missing or not what was written",
      });
      return z.NEVER;
    }
    return {
      ...rest,
      itemIndex,
      ask: asked,
      ...(branchKeys === undefined ? {} : { branchKeys }),
    };
  });

/** A pause from the JSON a store kept (parsed): read in the 0.1.1 shape, or unreadable (ids, field). */
export const pauseRecordOfJson = (value: unknown): PauseRecord =>
  readStored(StoredPause, value, "pause", ["pauseId", "executionId"]);
