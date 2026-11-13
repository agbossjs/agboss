/**
 * `@agboss/core/testing` — test a workflow without models and without the network: `testWith`
 * (Vitest fixtures `app`, `mockLlm`, `mockAction`, `mockTool`, `mockOf`, `mcpOf`, `recoverApp`,
 * `clock`), scripted model turns (`replyWith`, `callTool`, `routeTo`, `decideWith`, `failWith`,
 * `waitFor`, the invalid turns `callToolWithInvalidArguments`,
 * `callToolWithTruncatedArguments`, `replyWithInvalidAnswer`, bound to inputs with `when(…)`), the schedule of parallel branches
 * (`TestConcurrency`), the unit runners of single components (`testTool`, `testAction`,
 * `testJudge`, `testPii`, `testRouter`, `testArbiter`, `testRag`, `testGuardrail`, `testToolInterceptor`, `testCompaction`, `testReplyInterpreter`) and the matchers
 * (register them with `setupFiles: ["@agboss/core/testing/setup"]`). Vitest is an optional peer
 * dependency.
 * Wiki → Testing.
 */
import "../polyfills/symbol-metadata.js";
import "./vitest-types.js";

export { testWith, type WorkflowFixtures } from "./test-with.js";
export type { TestWithOptions } from "./environment.js";
export type { TestInstanceOptions } from "./instances.js";
export type { TestApp } from "./test-app.js";
export type { A2AServerFixture, A2ATestServer } from "./a2a-server.js";
export type { AgentSlice, RouterSlice, ToolSlice, ToolClassOf } from "./slices.js";
export {
  replyWith,
  callTool,
  callTools,
  routeTo,
  decideWith,
  failWith,
  waitFor,
  ModelCallFailedError,
  type ModelCallFailedErrorOptions,
  ModelFailure,
  type ToolClass,
} from "./script.js";
export {
  callToolWithInvalidArguments,
  callToolWithTruncatedArguments,
  replyWithInvalidAnswer,
  type InvalidFields,
} from "./invalid-turns.js";
export type {
  AnswerDetails,
  AnswerGiven,
  AnswerTurn,
  DecideDetails,
  DecideTurn,
  DecisionDetails,
  FailureTurn,
  InvalidAnswerTurn,
  InvalidToolCallTurn,
  TruncatedToolCallTurn,
  ReplyTurn,
  RouteTurn,
  ScriptedAnswer,
  ScriptedTurn,
  ToolCallTurn,
  ToolCallsTurn,
  WaitTurn,
} from "./turns.js";
export type { ChatLine, ModelRequest, ModelScript, WhenScript } from "./script-book.js";
export type {
  DeepPartial,
  InputMatcherOf,
  PartialValues,
  RecordedInputOf,
  ReturnedCheckOf,
  TurnFor,
} from "./script-types.js";
export type { ActionScript } from "./action-script.js";
export { ToolFailure, type ToolScript } from "./tool-script.js";
export type { CallAssertion, CallMatchers } from "./vitest-types.js";
export type { ExpectedErrorFields } from "./error-matcher.js";
export type { McpStub, McpStubCall } from "./mcp-stubs.js";
export { VirtualClock, type ClockDuration, type VirtualClockOptions } from "./clock.js";
export { ClockSkew, SkewedClock } from "./clock-skew.js";
// what a payment gateway must support (#508): a fake one, and the checklist a team runs on its own
export {
  FakeGatewayError,
  type FakeGatewayErrorOptions,
  FakeGatewayErrorKind,
  FakeGatewayFault,
  FakePaymentGateway,
  FULL_GATEWAY_CAPABILITIES,
  type FakeGatewayCapabilities,
  type FakeGatewayCharge,
  type FakeGatewayFaultOptions,
  type FakeGatewayPayment,
  type FakeGatewayReceipt,
  type FakePaymentGatewayOptions,
} from "./gateway/fake-payment-gateway.js";
export {
  GatewayCheckStatus,
  GatewayRequirement,
  paymentGatewayChecklist,
  type GatewayChecklistClock,
  type GatewayChecklistReport,
  type GatewayCheckResult,
  type GatewayProbeCharge,
  type GatewayProbeReceipt,
  type PaymentGatewayChecklistOptions,
} from "./gateway/payment-gateway-checklist.js";
export type { TestLeases } from "./leases.js";
export type { TestFenceOptions } from "./fence.js";
export { SequentialIdGenerator } from "./id-generator.js";
export { TestConcurrency, step, type OrderedStep } from "./concurrency/test-concurrency.js";
export { override, type Override } from "./units/override.js";
export type {
  UnitCallOptions,
  UnitClock,
  UnitModelOptions,
  UnitModelScript,
  UnitOptions,
  UnitRun,
} from "./units/unit-types.js";
export {
  testTool,
  type ToolInputOf,
  type ToolInstance,
  type ToolOutputOf,
  type ToolRunner,
} from "./units/test-tool.js";
export {
  testAction,
  type ActionInputOf,
  type ActionOutputOf,
  type ActionRunner,
} from "./units/test-action.js";
export { testJudge, type JudgeRunner } from "./units/test-judge.js";
export {
  testReplyInterpreter,
  type ReplyInterpreterReading,
  type ReplyInterpreterRunner,
  type ReplyInterpreterRunnerInput,
} from "./units/test-reply-interpreter.js";
export { testPii, type PiiRunner } from "./units/test-pii.js";
export { testRouter, type RouterRunner } from "./units/test-router.js";
export { testArbiter, type ArbiterRunner } from "./units/test-arbiter.js";
export { testRag, type RagCallOptions, type RagRunner } from "./units/test-rag.js";
export {
  testGuardrail,
  type GuardrailCallOptions,
  type GuardrailCheck,
  type GuardrailRunner,
} from "./units/test-guardrail.js";
export { testToolInterceptor, type ToolInterceptorRunner } from "./units/test-tool-interceptor.js";
export {
  testCompaction,
  type CompactionRequest,
  type CompactionResult,
  type CompactionRunner,
} from "./units/test-compaction.js";
export {
  AppCloseTimeoutError,
  CassetteChange,
  CassetteMissingError,
  StaleCassetteError,
  LiveCallBlockedError,
  TestFailure,
  TestSetupError,
  UnsettledWorkError,
  type AppCloseTimeoutErrorOptions,
  type StaleCassetteErrorOptions,
  type TestFailureCode,
  type TestFailureOptions,
  type UnsettledWorkErrorOptions,
} from "./errors.js";
export type { PlainErrorOptions } from "../core/errors.js";
export { type ExpectedRequest, type WorkflowMatchers } from "./matchers.js";
export {
  type ChildMatchers,
  type ExpectedChildExecution,
  type ExpectedHandling,
} from "./child-matchers.js";
export { type CompensationMatchers, type ExpectedCompensation } from "./compensation-matchers.js";
export { type ToolCallExpectation, type ToolCallMatchers } from "./tool-call-matchers.js";
export { UNSCRIPTED_SUMMARY } from "./scripted-gateway.js";
// #818: the graphs `agboss studio` serves, for a test that renders or inspects them
export { studioOf, type StudioGraph, type StudioGraphs, type StudioOptions } from "../studio.js";
export {
  testExecutionContext,
  type TestApplicationOptions,
  type TestContextOptions,
  type TestExecutionContextOptions,
  type TestStepOptions,
} from "./execution-context.js";

export { mcpServerStub } from "../components/mcp-client.js";
export { signedMeshEnvelope, type SignedMeshEnvelopeOptions } from "./mesh-envelope.js";

export { VcrMode, type VcrConfig } from "./vcr.js";
export * from "./vcr-deprecated.js";
export type * from "./public-types.js";
/** @beta Type machinery of the scripted turns and the matchers: not a contract, names may change. */
export type * as TestingTypes from "./testing-types.js";
