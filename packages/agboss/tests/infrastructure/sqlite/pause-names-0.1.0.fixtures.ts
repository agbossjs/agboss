/** What 0.1.0 wrote as JSON: a pause, an answer-log entry, a kept history record (#934). */

const STEP = {
  component: { name: "clerk-agent", kind: "agent" },
  nodeId: "clerk-agent",
  visitNumber: 1,
  idempotencyKey: "run-1:s:1",
  copyNumber: 1,
  validationAttempts: 0,
};

/** A 0.1.0 pause row's JSON: `answeredBy` is who may answer. */
export const oldPauseJson = JSON.stringify({
  threadId: "t-1",
  executionId: "run-1",
  workflow: "desk-workflow",
  nodeId: "clerk-agent",
  visitNumber: 1,
  copyNumber: 1,
  askedAt: "2026-01-05T09:00:00.000Z",
  kind: "approval",
  step: "clerk-agent",
  component: { name: "clerk-agent", kind: "agent" },
  channel: "refund-approval-channel",
  answeredBy: "channel",
  ask: { callId: "call-1", tool: "refund", arguments: { orderId: "7" }, summary: "refund 7" },
});

/** One 0.1.0 `PauseAnswerRecord`: `answeredBy` the kind, `responder` the person. */
const oldAnswer = (executionId: string, kind: string, person: string) => ({
  pauseId: undefined,
  executionId,
  step: STEP,
  role: "refund-approval-channel",
  answeredBy: kind,
  responder: person,
  resolution: "replied",
  askedAt: "2026-01-05T09:00:00.000Z",
  resolvedAt: "2026-01-05T09:05:00.000Z",
  decision: { approved: true },
});

export const oldAnswerLogEntry = oldAnswer("run-1", "channel", "manager-17");

/** A 0.1.0 `ExecutionHistoryRecord`: the root's pauses, a child's, and the child's child's. */
export const oldHistoryRecord = {
  executionId: "run-1",
  rootExecutionId: "run-1",
  threadId: "t-1",
  tenantId: "default",
  startedAt: "2026-01-05T09:00:00.000Z",
  status: "finished",
  pauses: [oldAnswer("run-1", "channel", "manager-17")],
  children: [
    {
      executionId: "child-1",
      pauses: [oldAnswer("child-1", "thread-owner", "alice")],
      children: [
        { executionId: "child-2", pauses: [oldAnswer("child-2", "channel", "bob")], children: [] },
      ],
    },
  ],
};
