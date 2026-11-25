/**
 * #906 AC1: each exported error's documented options (without `cause`), typed by its constructor —
 * `tsc` checks them — and keyed by the class's name. Part two: `error-options.fixtures-flow.ts`.
 */
import * as root from "../../src/index.js";
import * as stores from "../../src/stores/index.js";
import * as models from "../../src/models/index.js";
import { ModelKind } from "../../src/llm/decision-errors.js";
import { seconds } from "../../src/units/index.js";
import { ModelFailure } from "../../src/models/model-failure.js";
import { StoredNamesUnreadableError } from "../../src/infrastructure/stored-step.js";
import { fx } from "./error-options.fx.js";
import { flowFixtures } from "./error-options.fixtures-flow.js";

const message = "it went wrong";

export const fixtures: Readonly<Record<string, object>> = Object.fromEntries([
  fx(root.ApplicationStoppingError, { message }),
  fx(root.ExecutionCancelledError, { message }),
  fx(root.ExecutionStoppedError, { message }),
  fx(root.ExecutionPausedError, { message }),
  fx(root.ExecutionStopFencedError, {
    scopeKey: "acme:root-1",
    tenantId: "acme",
    rootExecutionId: "root-1",
    leaseExecutionId: "child-1",
    token: 2,
    effect: "charge",
  }),
  fx(root.ExecutionPauseFencedError, {
    scopeKey: "acme:root-1",
    tenantId: "acme",
    rootExecutionId: "root-1",
    leaseExecutionId: "child-1",
    token: 2,
    effect: "charge",
  }),
  fx(StoredNamesUnreadableError, { record: "pause", ids: "pauseId p1", fields: "respondent" }),
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
  fx(root.ExecutionCancelFencedError, {
    scopeKey: "acme:root-1",
    tenantId: "acme",
    rootExecutionId: "root-1",
    leaseExecutionId: "child-1",
    token: 2,
    effect: "charge",
  }),
  fx(root.CostLedgerCutoffInvalidError, { reason: "not a Date" }),
  fx(root.CostLedgerEntryExpiredError, { ledgerIds: ["l-1"], prunedBefore: new Date(0) }),
  fx(root.CostLedgerEntryInvalidError, { index: 0, reason: "no id" }),
  fx(stores.InvalidA2APageTokenError, {}),
  fx(root.PauseExtensionContendedError, { pauseKey: "default:p-1", attempts: 8 }),
  fx(root.UnknownPauseError, { message }),
  fx(root.NotPausedError, { message }),
  fx(root.PauseClosedError, {
    pauseId: "p-1",
    tenantId: "default",
    reason: root.PauseClosedReason.Cancelled,
    closedAt: "2026-01-05T09:00:00.000Z",
  }),
  fx(root.ExpiryHandlerError, {
    channel: "refund-approval-channel",
    problem: root.ExpiryProblem.HandlerFailed,
  }),
  fx(root.WorkingCalendarError, {
    calendar: "tenant-holidays-working-calendar",
    problem: root.WorkingCalendarProblem.CalendarFailed,
  }),
  fx(root.ReplyInterpreterMissingError, { message }),
  fx(root.UninterpretableReplyError, { message, reason: "no verdict" }),
  fx(root.EvalCaseInvalidError, {
    suite: "refund-suite",
    issues: [{ case: "c-1", path: "input", reason: "missing" }],
  }),
  fx(root.ModelKindError, { model: "gpt", kind: ModelKind.Chat, call: "decide" }),
  fx(models.ModelProviderFailureError, { failure: ModelFailure.Timeout, retryAfter: seconds(1) }),
  fx(root.ModelCallError, { code: "model.circuit-open", provider: "openai", message }),
  fx(models.ModelProviderInputError, { kind: "image", mediaType: "image/png" }),
  fx(root.ModelFileLimitError, {
    agent: "reader-agent",
    limit: root.ModelFileLimit.MaxFiles,
    actual: 6,
    allowed: 5,
  }),
  fx(root.FileRedactionFailedError, {
    agent: "reader-agent",
    reason: "the model's answer is not usable",
  }),
  fx(root.ToolTimeoutError, { timeout: seconds(1) }),
  fx(root.SpendOutsideStepError, { message }),
  fx(root.NotAWorkflowStartError, { message }),
  fx(root.ExecutionContextUnavailableError, { message }),
  ...Object.entries(flowFixtures),
]);
