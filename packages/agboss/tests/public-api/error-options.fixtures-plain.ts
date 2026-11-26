/**
 * #906 AC1 (D1), part three: the errors that are not `AGBossError`s — and the `AGBossError`s the
 * first pass missed: configuration, loading, testing and fault-suite errors. One options object each.
 */
import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { ProfileError } from "../../src/config/profile-error.js";
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
export const plainFixtures: Readonly<Record<string, object>> = Object.fromEntries([
  fx(ProfileError, { message }),
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
