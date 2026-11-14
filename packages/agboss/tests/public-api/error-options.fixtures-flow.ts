/** #906 AC1, part two: the step, limit, router, mesh and rag errors' options. */
import * as root from "../../src/index.js";
import * as rag from "../../src/rag/index.js";
import { BudgetPeriod, BudgetScope } from "../../src/budgets/budget.js";
import { ComponentKind, bareRecordOf } from "../../src/flow/runtime/records.js";
import { seconds, usd } from "../../src/units/index.js";
import { fx } from "./error-options.fx.js";

const workflow = { name: "refund-workflow", version: "1", startedVersion: "1", configHash: "a" };
const entry = { application: "orders", start: "orders-workflow-start" };
const chain = [{ ...entry, executionId: "root-1" }];
const lost = { path: ["refund-agent"], spentUsd: 0.5 };
const paid = { usage: [] };

export const flowFixtures: Readonly<Record<string, object>> = Object.fromEntries([
  fx(root.PaidStepError, { message: "it went wrong", ...paid, details: { step: 1 } }),
  fx(root.StepFailedError, {
    message: "it went wrong",
    ...paid,
    component: bareRecordOf("refund-agent", ComponentKind.Agent),
    nodeId: "refund-agent",
    visitNumber: 1,
    itemIndex: 0,
  }),
  fx(root.AgentFailedError, { agent: "refund-agent", ...paid, details: { step: 1 } }),
  fx(root.QualityGateError, {
    agent: "refund-agent",
    ...paid,
    rejections: [{ judge: "tone-judge", reason: "rude" }],
    retries: 2,
  }),
  fx(root.AgentAnswerInvalidError, { agent: "refund-agent", ...paid, attempts: 3 }),
  fx(root.GuardFailedError, { guard: "pii-guard", ...paid, reason: "its model did not answer" }),
  fx(root.ActionFailedError, { action: "charge-action" }),
  fx(root.QuestionFailedError, { question: "limit-question" }),
  fx(root.PauseExpiredError, {
    step: "limit-question",
    stepKind: ComponentKind.Question,
    channel: "limit-channel",
    kind: root.PauseKind.Question,
    expiresAt: "2026-01-05T09:00:00.000Z",
    ...paid,
  }),
  fx(root.ArbiterError, { arbiter: "score-arbiter", ...paid }),
  fx(root.QuorumNotReachedError, {
    launch: "root-1:fan-out:1",
    component: bareRecordOf("fan-out", ComponentKind.Agent),
    nodeId: "fan-out",
    visitNumber: 1,
    itemIndex: 0,
    min: 2,
    counted: 1,
    reason: "the deadline passed",
  }),
  fx(root.ChildExecutionFailedError, { childExecutionId: "child-1", workflow, ...paid }),
  fx(root.ToolBlockedError, {
    agent: "refund-agent",
    tool: "charge-tool",
    interceptor: "limit-interceptor",
    reason: "over the limit",
    ...paid,
  }),
  fx(root.GuardrailBlockedError, {
    guard: "toxicity-guard",
    refusal: "I cannot help with that",
    ...paid,
    probability: 0.9,
    threshold: 0.8,
  }),
  fx(root.PiiRefusedError, { kind: "card", refusal: "no cards here", ...paid }),
  fx(root.PiiDetectionFailedError, { message: "it went wrong", ...paid }),
  fx(root.RouterFailedError, { nodeId: "triage-router", visitNumber: 1 }),
  fx(root.RouterDecisionError, { nodeId: "triage-router", visitNumber: 1, reason: "no route" }),
  fx(rag.RerankFailedError, { rag: "faq-rag", reranker: "llm-reranker", ...paid }),
  fx(root.LimitExceededError, { key: "maxSteps", limit: 3, actual: 4, ...lost }),
  fx(root.BudgetExceededError, {
    budget: { name: "tenant-daily-budget" },
    scope: BudgetScope.Tenant,
    period: BudgetPeriod.Day,
    key: "acme",
    maxSpend: usd(40),
    spent: usd(40.05),
    ...lost,
  }),
  fx(root.StepsLimitExceededError, { workflow, maxSteps: 3, ...lost }),
  fx(root.VisitsLimitExceededError, {
    component: bareRecordOf("refund-agent", ComponentKind.Agent),
    maxVisits: 2,
    ...lost,
  }),
  fx(root.DepthLimitExceededError, { workflow, maxDepth: 2, path: ["refund-agent"] }),
  fx(root.DeadlineExceededError, {
    deadline: seconds(30),
    deadlineAt: "2026-01-01T00:00:30.000Z",
    ...lost,
  }),
  fx(root.MeshLoopDetectedError, { entry, chain, ...lost }),
  fx(root.HopsLimitExceededError, { entry, chain, maxMeshHops: 8, ...lost }),
  fx(root.CompensationFailedError, { failures: [] }),
]);
