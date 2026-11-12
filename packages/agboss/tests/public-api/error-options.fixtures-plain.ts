/**
 * #906 AC1 (D1), part three: the errors that are not `AGBossError`s — and the `AGBossError`s the
 * first pass missed: configuration, loading, testing and fault-suite errors. One options object each.
 */
import { ComponentError } from "../../src/components/metadata.js";
import { PromptError } from "../../src/components/prompt-problems.js";
import { ProfileError } from "../../src/config/profiles.js";
import { DtoError } from "../../src/dto/errors.js";
import { EnvironmentError, EnvironmentErrorCode } from "../../src/environments/errors.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import { ApplicationLoadError, WorkflowLoadError } from "../../src/loader/load-errors.js";
import { ConfigurationError } from "../../src/models/problems.js";
import { ModelProviderError } from "../../src/models/model-provider.decorator.js";
import { PromptCachingError } from "../../src/models/prompt-caching.js";
import { RateLimitPolicyError } from "../../src/models/policies/rate-limit-policy.js";
import { ReasoningError } from "../../src/models/reasoning.js";
import { RetryPolicyError } from "../../src/models/retry-policy.js";
import { UnitError } from "../../src/units/index.js";
import { ModelFailure } from "../../src/models/model-failure.js";
import {
  AppCloseTimeoutError,
  CassetteChange,
  CassetteMissingError,
  LiveCallBlockedError,
  StaleCassetteError,
  TestFailure,
  TestSetupError,
  UnsettledWorkError,
} from "../../src/testing/errors.js";
import { StoreConformanceError } from "../../src/testing/contracts/store-conformance-check.js";
import { StoreAnswerLostError } from "../../src/testing/faults/hold-points.js";
import {
  FaultInvariant,
  FaultInvariantError,
} from "../../src/testing/faults/invariants/violations.js";
import {
  FakeGatewayError,
  FakeGatewayErrorKind,
} from "../../src/testing/gateway/fake-payment-gateway.js";
import { ModelCallFailedError } from "../../src/testing/script.js";
import { fx } from "./error-options.fx.js";

const message = "it went wrong";
const problem = {
  code: "prompt.unknown-variable",
  message: "a.md:3 {{x}} — known: (none)",
} as const;

export const plainFixtures: Readonly<Record<string, object>> = Object.fromEntries([
  fx(ComponentError, { message }),
  fx(PromptError, { problems: [problem] }),
  fx(EnvironmentError, { code: EnvironmentErrorCode.NotFound, message }),
  fx(DtoError, { code: "dto.no-metadata", message }),
  fx(WorkflowLoadError, { message }),
  fx(ApplicationLoadError, { message }),
  fx(GraphRuleError, { violations: [{ code: "graph.not-a-node", message, nodes: ["A"] }] }),
  fx(ConfigurationError, {
    problems: [
      { code: "model.unsupported-setting", key: "k", value: "v", model: "m", supported: "s" },
    ],
  }),
  fx(ModelProviderError, { message }),
  fx(ProfileError, { message }),
  fx(UnitError, { message }),
  fx(ReasoningError, { message }),
  fx(PromptCachingError, { message }),
  fx(RetryPolicyError, { message }),
  fx(RateLimitPolicyError, { message }),
  fx(TestFailure, { code: "test.app-closed", message }),
  fx(LiveCallBlockedError, { message }),
  fx(CassetteMissingError, { message }),
  fx(StaleCassetteError, {
    file: "a.cassette.json",
    component: "A",
    changes: [CassetteChange.Prompt],
  }),
  fx(AppCloseTimeoutError, { instance: 1, timeout: 5000 }),
  fx(UnsettledWorkError, { inFlight: 2, settleTimeout: 5000, isLoad: true }),
  fx(TestSetupError, { message }),
  fx(ModelCallFailedError, { failure: ModelFailure.Timeout, component: "A" }),
  fx(FakeGatewayError, { kind: FakeGatewayErrorKind.Unavailable, message }),
  fx(StoreConformanceError, { problems: ["[store-conformance.empty] nothing"] }),
  fx(StoreAnswerLostError, { message }),
  fx(FaultInvariantError, {
    scenario: "s",
    violations: [{ invariant: FaultInvariant.OneOwner, message }],
    notes: ["n"],
  }),
]);
