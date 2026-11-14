/**
 * #906 AC1: each exported error's documented options (without `cause`), typed by its constructor —
 * `tsc` checks them — and keyed by the class's name. Part two: `error-options.fixtures-flow.ts`.
 */
import * as a2a from "../../src/a2a/index.js";
import * as root from "../../src/index.js";
import * as models from "../../src/models/index.js";
import { OutboundCallPart } from "../../src/app/outbound-calls.js";
import { TokenLimit } from "../../src/config/types.js";
import { FingerprintProblem } from "../../src/infrastructure/fenced-effect-fingerprint.js";
import { ModelKind } from "../../src/llm/decision-errors.js";
import { seconds } from "../../src/units/index.js";
import { ModelFailure } from "../../src/models/model-failure.js";
import { StoredNamesUnreadableError } from "../../src/infrastructure/stored-step.js";
import { fx } from "./error-options.fx.js";
import { flowFixtures } from "./error-options.fixtures-flow.js";

const call = { call: "charge", target: "payments", operation: "charge" };
const task = { agent: "refund-agent", taskId: "t-1", contextId: "c-1" };
const message = "it went wrong";

export const fixtures: Readonly<Record<string, object>> = Object.fromEntries([
  fx(root.ApplicationStoppingError, { message }),
  fx(root.DuplicateExecutionIdError, { generator: "SequentialIds" }),
  fx(root.ExecutionCancelledError, { message }),
  fx(root.InvalidMintedIdError, {
    generator: "G",
    method: "newThreadId",
    rule: root.KeyTextRule.Length,
  }),
  fx(root.ThreadIdsExhaustedError, { generator: "G", tries: 100 }),
  fx(root.BusinessKeyConflictError, { effect: "charge", businessKeyHash: "h-1" }),
  fx(root.FingerprintNotJsonError, { effect: "charge", path: "$.at", reason: "a Date" }),
  fx(root.FingerprintRequiredError, { effect: "charge", reason: FingerprintProblem.Missing }),
  fx(root.IdempotencyKeyMissingError, { effect: "charge" }),
  fx(StoredNamesUnreadableError, { record: "pause", ids: "pauseId p1", fields: "answerer" }),
  fx(root.InvalidBusinessKeyError, { effect: "charge", rule: root.KeyTextRule.Length }),
  fx(root.InvalidFencedEffectNameError, { length: 120 }),
  fx(root.FencedEffectResultTooLargeError, { effect: "charge", size: 10, maxResultSize: 5 }),
  fx(root.FencedEffectStoreMismatchError, {
    fencedEffectRepository: "A",
    leaseRepository: "B",
    expectedLeaseRepository: "C",
  }),
  fx(root.SyncWorkRequiredError, { effect: "charge" }),
  fx(root.ExecutionLeaseLostError, { rootExecutionId: "root-1" }),
  fx(root.StoreOutcomeUnknownError, {
    store: "PgFencedEffectRepository",
    operation: "runOnce",
    source: root.StoreOutcomeSource.Transport,
  }),
  fx(root.StoreCallTimeoutError, {
    store: "PgFencedEffectRepository",
    operation: "runOnce",
    source: root.StoreOutcomeSource.Command,
    timeout: seconds(10),
  }),
  fx(root.ExecutionFencedError, {
    scopeKey: "acme:root-1",
    tenantId: "acme",
    leaseExecutionId: "root-1",
    token: 2,
    observedToken: 3,
  }),
  fx(root.ExecutionCancelFencedError, {
    scopeKey: "acme:root-1",
    tenantId: "acme",
    rootExecutionId: "root-1",
    leaseExecutionId: "child-1",
    token: 2,
    effect: "charge",
  }),
  fx(root.InvalidNotSentTrustError, { call: "charge", problem: "notSent is undefined" }),
  fx(root.OutboundCallInFlightError, call),
  fx(root.OutboundCallPayloadTooLargeError, {
    call: "charge",
    part: OutboundCallPart.Request,
    size: 10,
    maxPayloadSize: 5,
  }),
  fx(root.OutboundCallResultNotStoredError, { ...call, reason: "outbound-call.unmasked" }),
  fx(root.OutboundCallSupersededError, {
    ...call,
    idempotencyKey: "k-1",
    attempt: 1,
    supersededBy: 2,
  }),
  fx(root.OutboundCallUnmaskedError, { call: "charge" }),
  fx(root.OutboundCallUnreconciledError, {
    ...call,
    idempotencyKey: "k-1",
    reason: "reconcile.threw",
    detail: "reconcile threw",
  }),
  fx(root.CostLedgerCutoffInvalidError, { reason: "not a Date" }),
  fx(root.CostLedgerEntryExpiredError, { ledgerIds: ["l-1"], prunedBefore: new Date(0) }),
  fx(root.CostLedgerEntryInvalidError, { index: 0, reason: "no id" }),
  fx(root.A2AFileConflictError, { fileId: "f-1" }),
  fx(root.InvalidA2APageTokenError, {}),
  fx(root.PauseAnswererError, { message }),
  fx(root.UnknownPauseError, { message }),
  fx(root.NotPausedError, { message }),
  fx(root.PauseClosedError, {
    pauseId: "p-1",
    tenantId: "default",
    reason: root.PauseClosedReason.Cancelled,
    closedAt: "2026-01-05T09:00:00.000Z",
  }),
  fx(root.UnknownThreadError, { message }),
  fx(root.ThreadOwnerError, { message }),
  fx(root.InvalidThreadIdError, { rule: root.KeyTextRule.Length }),
  fx(root.IncompatibleResumeError, {
    threadId: "t-1",
    executionId: "e-1",
    paused: { workflowVersion: "1", configHash: "a" },
    current: { workflowVersion: "2", configHash: "b" },
  }),
  fx(root.ReplyInterpreterMissingError, { message }),
  fx(root.UninterpretableReplyError, { message, reason: "no verdict" }),
  fx(root.CompactionError, {
    message,
    compaction: "conversation-compaction",
    summaryMaxTokens: TokenLimit.MODEL_MAX,
  }),
  fx(root.DtoValidationError, { dto: "Order", issues: [{ path: "id", reason: "missing" }] }),
  fx(root.EvalCaseInvalidError, {
    suite: "refund-suite",
    issues: [{ case: "c-1", path: "input", reason: "missing" }],
  }),
  fx(root.DecisionError, { message }),
  fx(root.DecisionRequestError, { message }),
  fx(root.DecisionResponseError, { message }),
  fx(root.ModelKindError, { model: "gpt", kind: ModelKind.Chat, call: "decide" }),
  fx(models.ModelProviderFailureError, { failure: ModelFailure.Timeout, retryAfter: seconds(1) }),
  fx(root.ModelCallError, { code: "model.circuit-open", provider: "openai", message }),
  fx(root.ToolTimeoutError, { timeout: seconds(1) }),
  fx(root.SpendOutsideStepError, { message }),
  fx(root.NotAWorkflowStartError, { message }),
  fx(root.FlowSyntaxError, { message }),
  fx(root.ExecutionContextUnavailableError, { message }),
  fx(root.OutputInvalidError, { message }),
  fx(a2a.A2ACallerRejectedError, {
    httpStatus: 403,
    wireCode: "a2a.caller-forbidden",
    reason: "no",
  }),
  fx(a2a.A2AContractError, {
    agent: "refund-agent",
    rule: a2a.A2AContractRule.UnknownSkill,
    skill: "refund",
    differences: ["input: currency"],
  }),
  fx(a2a.A2AProtocolError, {
    agent: "refund-agent",
    operation: a2a.A2AClientOperation.GetTask,
    rpcCode: -32001,
    httpStatus: 500,
    protocolVersions: ["0.3"],
  }),
  fx(a2a.A2ARemoteCallError, {
    agent: "refund-agent",
    reason: a2a.A2ARemoteCallReason.NoOutput,
    taskId: "t-1",
  }),
  fx(a2a.A2AUnexpectedFinishError, {
    agent: "refund-agent",
    finish: "other-finish",
    finishes: ["refund-finish"],
    taskId: "t-1",
  }),
  fx(a2a.A2AMeshUnsupportedError, { agent: "refund-agent", application: "refunds" }),
  fx(a2a.A2AOriginError, {
    agent: "refund-agent",
    origin: "https://x.example",
    site: a2a.A2AOriginSite.Redirect,
    allowedOrigins: ["https://y.example"],
  }),
  fx(a2a.A2ACallDeadlineError, {
    ...task,
    deadlineAt: "2026-01-01T00:00:00.000Z",
    cancel: a2a.A2ACancelOutcome.Canceled,
  }),
  fx(a2a.A2ATaskCanceledError, task),
  fx(a2a.A2ATaskFailedError, { ...task, end: a2a.A2ATaskEnd.Failed, remoteCode: "limit.hops" }),
  fx(a2a.A2ATaskInterruptedError, { ...task, interruption: a2a.A2ATaskInterruption.InputRequired }),
  fx(a2a.A2AFileRefusedError, {
    refusal: a2a.A2AFileRefusal.TooLarge,
    mediaType: "image/png",
    sizeBytes: 10,
  }),
  fx(a2a.A2AFileUnavailableError, { reason: a2a.A2AFileUnavailableReason.NotFound }),
  ...Object.entries(flowFixtures),
]);
