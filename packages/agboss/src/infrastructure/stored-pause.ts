import { z } from "zod";
import { PauseAnswerer } from "../channels/channel-role.decorator.js";
import {
  ExpiryProblem,
  PauseExpiryBound,
  PauseKind,
  PauseResolution,
  PauseStatus,
  questionAskOf,
  StoredAnswer,
  type PauseAsk,
  type PauseRecord,
} from "./pause-record.js";
import { readStored, StoredComponent } from "./stored-step.js";

/**
 * A pause as a store keeps it as JSON (#934): every field of `PauseRecord`, either shape of the
 * names — 0.1.0's `answeredBy` (who may answer) or the new `answerer` — with the answer it embeds
 * checked inside. Parsing is reading: the record that comes out has the new names.
 */

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

/** A pause record as JSON stored it, in either shape of the names; parsing it reads it. */
export const StoredPause = z
  .object({
    threadId: z.string(),
    executionId: z.string(),
    workflow: z.string(),
    nodeId: z.string(),
    visitNumber: z.number(),
    itemIndex: z.number().optional(),
    // a pause stored before #267 S107 kept neither: the first copy, asked at an unknown time
    copyNumber: z.number().default(1),
    askedAt: z.string().default(""),
    kind: z.enum(PauseKind),
    step: z.string(),
    component: StoredComponent.optional(),
    toolLoopIteration: z.number().optional(),
    validationAttempts: z.number().optional(),
    channel: z.string(),
    // a pause stored before #337 has none: its own step's key is its only branch key
    branchKeys: z.array(z.string()).optional(),
    answerer: z.enum(PauseAnswerer).optional(),
    answeredBy: z.enum(PauseAnswerer).optional(),
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
    answer: StoredAnswer.optional(),
  })
  .transform((stored, context): PauseRecord => {
    const { branchKeys, itemIndex, ask, answerer, answeredBy, ...rest } = stored;
    const kind = answerer ?? answeredBy;
    const asked = askOfStored(stored.kind, ask);
    if (kind === undefined || asked === undefined) {
      const path = kind === undefined ? "answerer" : "ask";
      context.addIssue({
        code: "custom",
        path: [path],
        message: "missing or not what was written",
      });
      return z.NEVER;
    }
    return {
      ...rest,
      itemIndex,
      answerer: kind,
      ask: asked,
      ...(branchKeys === undefined ? {} : { branchKeys }),
    };
  });

/** A pause from the JSON a store kept (parsed): read in either shape, or unreadable (ids, field). */
export const pauseRecordOfJson = (value: unknown): PauseRecord =>
  readStored(StoredPause, value, "pause", ["pauseId", "executionId"]);
