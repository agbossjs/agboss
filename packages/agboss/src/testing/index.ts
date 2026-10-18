/**
 * `agboss/testing` — test a workflow without models and without the network: `testWith`
 * (Vitest fixtures `app`, `mockLlm`, `mockOf`, `mcpOf`, `recoverApp`), scripted model turns
 * (`replyWith`, `callTool`, `routeTo`, `decideWith`, `failWith`) and the matchers (register them with
 * `setupFiles: ["agboss/testing/setup"]`). Vitest is an optional peer dependency.
 * Wiki → Testing.
 */
import "../polyfills/symbol-metadata.js";
import "./vitest-types.js";

export { testWith, type WorkflowFixtures } from "./test-with.js";
export type { TestWithOptions } from "./environment.js";
export type { TestApp } from "./test-app.js";
export type { AgentSlice, RouterSlice, ToolSlice, ToolClassOf } from "./slices.js";
export {
  replyWith,
  callTool,
  routeTo,
  decideWith,
  failWith,
  ModelCallFailedError,
  ModelFailure,
  type AnswerDetails,
  type DecideDetails,
  type DecisionDetails,
  type ScriptedAnswer,
  type ScriptedTurn,
  type ToolClass,
} from "./script.js";
export type { ChatLine, ModelRequest, ModelScript } from "./script-book.js";
export type { McpStub, McpStubCall } from "./mcp-stubs.js";
export type { ClockDuration, TestClock } from "./clock.js";
export {
  CassetteMissingError,
  LiveCallBlockedError,
  TestFailure,
  TestSetupError,
  type TestFailureCode,
} from "./errors.js";
export {
  workflowMatchers,
  type ExpectedFailure,
  type ExpectedRequest,
  type WorkflowMatchers,
} from "./matchers.js";
export { UNSCRIPTED_SUMMARY } from "./scripted-gateway.js";
export { workflowOf } from "./workflow-of.js";
export { toolOf } from "../components/runtime.js";
export {
  testExecutionContext,
  type TestApplicationOptions,
  type TestContextOptions,
  type TestExecutionContextOptions,
  type TestStepOptions,
} from "./execution-context.js";

export { mcpServerStub } from "../components/mcp-client.js";

export { VCRMode, type VcrConfig } from "./vcr.js";
