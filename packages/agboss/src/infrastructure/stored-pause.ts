import { z } from "zod";
import { CostSource } from "../finops/usage.js";
import {
  ExpiryProblem,
  PauseExpiryBound,
  PauseKind,
  PauseResolution,
  PauseStatus,
  type PauseAnswer,
  type PauseRecord,
} from "./pause-record.js";
import { storedUsd } from "../finops/cost-report.js";
import {
  actorOf,
  readStored,
  StoredActor,
  StoredComponent,
  StoredTrailEntry,
} from "./stored-step.js";
import { PauseRespondent } from "../pause/respondent.js";

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
    actor: StoredActor.optional(),
    // 0.1.0's names of `actor` (the person) and of `byDelegate`: refused, never read
    answeredBy: z.never().optional(),
    respondent: z.never().optional(),
    byChannel: z.never().optional(),
    // #1197: the delegate channel's own decision; `false` is no marker
    byDelegate: z.boolean().optional(),
    usage: z.array(StoredUsage).optional(),
  })
  .transform((stored): PauseAnswer => ({
    decision: stored.decision,
    actor: stored.actor === undefined ? undefined : actorOf(stored.actor),
    ...(stored.byDelegate === true ? { byDelegate: true as const } : {}),
    ...(stored.usage === undefined ? {} : { usage: stored.usage }),
  }));

/** The tool call an approval pause waits on. */
export const StoredPauseToolCall = z.object({
  callId: z.string(),
  tool: z.string(),
  summary: z.string().optional(),
});

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
    // the target it waits under; the channel asked, absent for an owner's pause nobody is asked about
    target: z.string(),
    channel: z.string().optional(),
    // a pause stored before #337 has none: its own step's key is its only branch key
    branchKeys: z.array(z.string()).optional(),
    respondent: z.enum(PauseRespondent),
    // 0.1.0's name of `respondent` (who may answer): refused, never read, never filled from 0.1.1
    answeredBy: z.never().optional(),
    // what it asks (an approval's arguments, a question role's own ask) and, for an approval, its call
    input: z.record(z.string(), z.unknown()),
    toolCall: StoredPauseToolCall.optional(),
    // 0.1.0's name of `input` + `toolCall`: refused, never read
    ask: z.never().optional(),
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
    assignees: z.array(z.string()).min(1).optional(),
    assignee: z.never().optional(),
    externalRef: z.string().optional(),
    trail: z.array(StoredTrailEntry).min(1),
    reassignedTo: z.string().optional(),
    reassignedFrom: z.string().optional(),
    answer: StoredAnswer.optional(),
  })
  .transform((stored, context): PauseRecord => {
    const { branchKeys, itemIndex, toolCall, assignees, externalRef, channel, ...rest } = stored;
    // an approval is a tool call's; a question has none: `kind` and `toolCall` agree
    if ((stored.kind === PauseKind.Approval) !== (toolCall !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["toolCall"],
        message: "missing or not what was written",
      });
      return z.NEVER;
    }
    return {
      ...rest,
      itemIndex,
      ...(channel === undefined ? {} : { channel }),
      ...(toolCall === undefined ? {} : { toolCall }),
      ...(assignees === undefined ? {} : { assignees }),
      ...(externalRef === undefined ? {} : { externalRef }),
      ...(branchKeys === undefined ? {} : { branchKeys }),
    };
  });

/** A pause from the JSON a store kept (parsed): read in the 0.1.1 shape, or unreadable (ids, field). */
export const pauseRecordOfJson = (value: unknown): PauseRecord =>
  readStored(StoredPause, value, "pause", ["pauseId", "executionId"]);
