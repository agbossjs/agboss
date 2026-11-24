import type { PausedExecution } from "../../app/paused-runs.js";
import { ExecutionStatus } from "../../app/types.js";
import { buildCostReport } from "../../finops/usage.js";
import {
  PauseStatus,
  type PauseAnswer,
  type PauseRecord,
} from "../../infrastructure/paused-execution.repository.js";
import { PauseAnswerer } from "../../channels/channel-role.decorator.js";
import { PauseKind, questionAskOf } from "../../infrastructure/pause-record.js";
import { PauseExpiryBound } from "../../infrastructure/pause-record.js";
import type { PauseRecipients } from "../../infrastructure/pause-notices.js";
import { bareRecordOf, ComponentKind } from "../../flow/runtime/records.js";

/** The data of the paused-execution contract: paused runs, pauses and answers. */

/** A paused run as the app stores it (`budgetUsd: Infinity` — a run without a cost limit). */
export const pausedRunOf = (threadId: string, runId = "run-1"): PausedExecution => ({
  run: {
    runId,
    threadId,
    tenantId: "default",
    turnId: "turn-1",
    status: ExecutionStatus.Paused,
    start: "order-workflow-start",
    startInput: { text: "charge" },
    budgetUsd: Number.POSITIVE_INFINITY,
    path: ["start", "clerk"],
    cost: buildCostReport([]),
    data: { scope: {}, outdatedValues: [], lastError: null },
    pending: [],
  },
  workflowVersion: "1.0.0",
  configHash: "hash",
});

/** A new pause of a step, as the pause step makes it. */
export const pauseOf = (pauseId: string, stepKey = "run-1:clerk-agent:1:call-1"): PauseRecord => ({
  pauseId,
  tenantId: "default",
  threadId: "thread-1",
  rootExecutionId: "run-1",
  executionId: "run-1",
  workflow: "order-workflow",
  stepKey,
  nodeId: "clerk-agent",
  visitNumber: 1,
  itemIndex: undefined,
  copyNumber: 1,
  kind: PauseKind.Approval,
  step: "clerk-agent",
  channel: "refund-approval-channel",
  answerer: PauseAnswerer.Channel,
  ask: { callId: "call-1", tool: "charge", arguments: { text: "10 USD" }, summary: "charge" },
  status: PauseStatus.Pending,
  isSent: false,
  askedAt: "2026-01-05T09:00:00.000Z",
});

/** What a channel decided at once. */
export const DECIDED_ANSWER: PauseAnswer = { decision: { approved: true }, answeredBy: undefined };

/** A person's approval. */
export const APPROVED_BY_MANAGER: PauseAnswer = {
  decision: { approved: true },
  answeredBy: "manager-17",
};

/** The moments the cases resolve pauses at. */
export const NINE = new Date("2026-01-05T09:00:00.000Z");
export const TEN = new Date("2026-01-05T10:00:00.000Z");

/**
 * #746: a question role's pause (#659, #712) — `kind: PauseKind.Question`, its step's component the
 * role and its ask the role's own DTO, no tool call: a store keeps them as written.
 */
export const questionPauseOf = (
  pauseId: string,
  stepKey = "run-1:spending-limit-question:1",
): PauseRecord => ({
  ...pauseOf(pauseId, stepKey),
  nodeId: "spending-limit-question",
  kind: PauseKind.Question,
  step: "spending-limit-question",
  channel: "spending-limit-question",
  component: bareRecordOf("spending-limit-question", ComponentKind.Question),
  ask: questionAskOf({ item: "laptop", priceUsd: 1200, nested: { tags: ["it", "q4"] } }),
});

/**
 * 0.1.1: a pause's `kind` is the record's own fact — a store keeps it as written and never infers
 * it from the component: a question with no component (a record from before components), and an
 * approval whose component a project's own store would read as a question.
 */
export const kindOnlyPausesOf = (): readonly PauseRecord[] => {
  return [
    { ...questionPauseOf("pause-k1", "run-1:q:1"), component: undefined },
    {
      ...pauseOf("pause-k2", "run-1:clerk-agent:1:call-9"),
      component: bareRecordOf("clerk-agent", ComponentKind.Question),
    },
  ];
};

/** A question's answer: the role's answer DTO, not an approval. */
export const QUESTION_ANSWER: PauseAnswer = {
  decision: { approved: true, limitUsd: 900 },
  answeredBy: "manager-17",
};

/** The deadline of the pauses of the deadline cases, and the instants a millisecond around it. */
export const DEADLINE = new Date("2026-01-05T10:00:00.000Z");
export const BEFORE_DEADLINE = new Date(DEADLINE.getTime() - 1);
/** An instant between the reminder and the deadline of `expiringPauseOf`. */
export const MID = new Date("2026-01-05T09:45:00.000Z");
export const AFTER_DEADLINE = new Date(DEADLINE.getTime() + 1);

/** A pause with a deadline at `DEADLINE` and a reminder half an hour before it. */
export const expiringPauseOf = (
  pauseId: string,
  stepKey = "run-1:clerk-agent:1:call-1",
): PauseRecord => ({
  ...pauseOf(pauseId, stepKey),
  expiresAt: DEADLINE.toISOString(),
  expiryBound: PauseExpiryBound.Pause,
  remindAt: "2026-01-05T09:30:00.000Z",
});

/** The receivers of the notice cases: the pause's channel and two listeners. */
export const RECIPIENTS: PauseRecipients = {
  channel: "refund-approval-channel",
  listeners: ["audit-listener", "slack-listener"],
};
export const CHANNEL_KEY = "channel:refund-approval-channel";
export const LISTENER_KEYS = ["listener:audit-listener", "listener:slack-listener"] as const;
export const ALL_KEYS = [CHANNEL_KEY, ...LISTENER_KEYS] as const;
