/**
 * #906 AC1: each exported error's documented options (without `cause`), typed by its constructor —
 * `tsc` checks them — and keyed by the class's name. Part two: `error-options.fixtures-flow.ts`.
 */
import { StoreError } from "../../src/core/error-families/store-errors.js";
import * as root from "../../src/index.js";
import * as stores from "../../src/stores/index.js";
import * as models from "../../src/models/index.js";
import { ModelKind } from "../../src/llm/decision-errors.js";
import { seconds } from "../../src/units/index.js";
import { ModelFailure } from "../../src/models/model-failure.js";
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
  fx(StoreError.UnreadableRecord, { record: "pause", ids: "pauseId p1", fields: "respondent" }),
  fx(root.ExecutionLeaseLostError, { rootExecutionId: "root-1" }),
  fx(root.ExecutionCancelFencedError, {
    scopeKey: "acme:root-1",
    tenantId: "acme",
    rootExecutionId: "root-1",
    leaseExecutionId: "child-1",
    token: 2,
    effect: "charge",
  }),
  fx(stores.InvalidA2APageTokenError, {}),
  fx(root.NotPausedError, { message }),
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
  fx(root.ExecutionContextUnavailableError, { message }),
  ...Object.entries(flowFixtures),
]);
