import type { PausedExecution } from "../../app/paused-runs.js";
import { ExecutionStatus } from "../../app/types.js";
import { buildCostReport } from "../../finops/usage.js";
import {
  PauseStatus,
  type PauseAnswer,
  type PauseRecord,
} from "../../infrastructure/paused-execution.repository.js";
import { PauseAnswerer } from "../../channels/channel-role.decorator.js";

/** The data of the paused-execution contract: paused runs, pauses and answers. */

/** A paused run as the app stores it (`budgetUsd: Infinity` — a run without a cost limit). */
export const pausedRunOf = (threadId: string, runId = "run-1"): PausedExecution => ({
  run: {
    runId,
    threadId,
    tenantId: "default",
    ternId: "tern-1",
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
  agent: "clerk-agent",
  channel: "refund-approval-channel",
  answeredBy: PauseAnswerer.Channel,
  ask: { callId: "call-1", tool: "charge", arguments: { text: "10 USD" }, summary: "charge" },
  status: PauseStatus.Pending,
  isSent: false,
  askedAt: "2026-01-05T09:00:00.000Z",
});

/** What a channel decided at once. */
export const DECIDED_ANSWER: PauseAnswer = { decision: { approved: true }, answerer: undefined };

/** A person's approval. */
export const APPROVED_BY_MANAGER: PauseAnswer = {
  decision: { approved: true },
  answerer: "manager-17",
};

/** The moments the cases resolve pauses at. */
export const NINE = new Date("2026-01-05T09:00:00.000Z");
export const TEN = new Date("2026-01-05T10:00:00.000Z");
