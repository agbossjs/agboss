import { z } from "zod";
import { GuardrailSide } from "../components/policy-decorators.js";
import type { ErrorRecord } from "../core/error-record.js";
import { CompensationReason, CompensationStatus } from "../flow/compensation.js";
import type { CompensationRecord } from "../flow/compensation.js";
import { OutdatedReason, type ScopeValueRecord } from "../flow/runtime/records.js";
import type { OutdatedValueRecord } from "../flow/runtime/records.js";
import { ToolCallStatus, type ToolCallRecord } from "../flow/runtime/tool-calls.js";
import type { ExecutionStepRecord } from "../flow/runtime/step-records.js";
import type { StepRecord } from "../flow/context/execution-context.js";
import { CostCategory, CostSource, type CostReport } from "../finops/usage.js";
import type { ExecutionOrigin } from "../mesh/mesh-envelope.js";
import { ChildExecutionStatus, type EndedChildRecord } from "../flow/runtime/child-records.js";
import { StoredComponent } from "./stored-step.js";

/**
 * The records an execution keeps (`ExecutionRecord`, #267, #395, #401) as JSON stored them, version
 * tolerant: a field that 0.1.0 already kept is required and checked by its type, one added after
 * (`CostReport.unknownCalls`: 0 before it) is optional or has a default, a key the type does not
 * know is dropped. Parsing a value reads it: what comes out IS the record type, nothing is asserted.
 */

const text = z.string();
const count = z.number();

/** An error as its record keeps it: its class line and its causes (#395). */
export const StoredError: z.ZodType<ErrorRecord> = z.lazy(() =>
  z.object({
    name: text,
    code: text,
    lineage: z.array(text),
    message: text,
    details: z.record(text, z.unknown()).optional(),
    cause: StoredError.optional(),
  }),
);

/** A step: its component, node, visit, copy, item and call — `compensates` only on an undo's. */
export const StoredStepRecord: z.ZodType<StepRecord> = z.lazy(() =>
  z
    .object({
      component: StoredComponent,
      nodeId: text,
      visitNumber: count,
      idempotencyKey: text,
      callId: text.optional(),
      itemIndex: count.optional(),
      copyNumber: count,
      toolLoopIteration: count.optional(),
      validationAttempts: count,
      compensates: StoredStepRecord.optional(),
    })
    .transform((step): StepRecord => ({
      ...step,
      callId: step.callId,
      itemIndex: step.itemIndex,
      toolLoopIteration: step.toolLoopIteration,
    })),
);

const tokens = {
  inputTokens: count,
  outputTokens: count,
  cacheReadTokens: count,
  cacheWriteTokens: count,
};

const StoredCostLine = z.object({
  caller: text,
  category: z.enum(CostCategory),
  model: text,
  costUsd: count,
  costSource: z.enum(CostSource),
  servedBy: text.optional(),
  ...tokens,
});

/** What a run cost (`unknownCalls` since #853: none before it). */
export const StoredCostReport: z.ZodType<CostReport> = z.object({
  totalUsd: count,
  calls: count,
  unknownCalls: count.default(0),
  cacheReadTokens: count,
  byCaller: z.record(text, count),
  byCategory: z.record(z.enum(CostCategory), count),
  byModel: z.record(text, count),
  trace: z.array(StoredCostLine),
});

const StoredJudgeVerdict = z.object({
  judge: StoredComponent,
  attempt: count,
  passed: z.boolean(),
  reason: text.optional(),
  metrics: z.record(text, z.union([count, text, z.boolean()])).optional(),
});

const StoredGuardrailDecision = z.object({
  guardrail: StoredComponent,
  side: z.enum(GuardrailSide),
  isBlocked: z.boolean(),
  probability: count,
});

/** One visit of a node (#395 C3). */
export const StoredExecutionStep: z.ZodType<ExecutionStepRecord> = z.object({
  step: StoredStepRecord,
  inputHash: text,
  decision: text.optional(),
  judgeVerdicts: z.array(StoredJudgeVerdict),
  guardrailDecisions: z.array(StoredGuardrailDecision),
  spend: StoredCostReport,
  startedAt: text,
  endedAt: text,
  error: StoredError.optional(),
});

/** One tool call (#395). */
export const StoredToolCall: z.ZodType<ToolCallRecord> = z.object({
  step: StoredStepRecord,
  input: z.unknown(),
  output: z.unknown(),
  status: z.enum(ToolCallStatus),
  error: StoredError.optional(),
  isResultTruncated: z.boolean(),
  startedAt: text,
  endedAt: text,
  remote: z.object({ application: text, executionId: text }).optional(),
});

const scopeShape = {
  valueId: text,
  slot: text,
  producer: text,
  elementProducers: z.array(text).optional(),
  variant: text.optional(),
  value: z.unknown(),
  builtFrom: z.array(text),
  about: z.array(text).optional(),
};

/** A value of the execution's scope. */
export const StoredScopeValue: z.ZodType<ScopeValueRecord> = z.object(scopeShape);

/** A value of the scope that was outdated. */
export const StoredOutdatedValue: z.ZodType<OutdatedValueRecord> = z.object({
  ...scopeShape,
  outdated: z.object({ byValueId: text, reason: z.enum(OutdatedReason) }),
});

/** An undo that ran (#340). */
export const StoredCompensation: z.ZodType<CompensationRecord> = z.object({
  compensated: StoredStepRecord,
  compensator: StoredComponent,
  reason: z.enum(CompensationReason),
  status: z.enum(CompensationStatus),
  error: StoredError.optional(),
  startedAt: text,
  endedAt: text,
});

/** Where a mesh peer's request came from (#398). */
export const StoredOrigin: z.ZodType<ExecutionOrigin> = z.object({
  rootExecutionId: text,
  executionId: text,
  parentExecutionId: text.optional(),
  workflow: z.object({ name: text, version: text }),
  step: z.object({ component: text, idempotencyKey: text, tool: text.optional() }),
  application: text,
  hops: count,
});

/** The workflow of an execution or a child: its name, versions and fingerprint. */
export const StoredWorkflow = z.object({
  name: text,
  version: text,
  startedVersion: text,
  configHash: text,
});

/** What a child that ended keeps but its children (#263). */
export const storedEndedShape = {
  executionId: text,
  parentExecutionId: text,
  rootExecutionId: text,
  workflow: StoredWorkflow,
  itemIndex: count.optional(),
  depth: count,
  launchedBy: z.object({ nodeId: text, visitNumber: count }),
  start: StoredComponent,
  input: z.unknown(),
  status: z.enum(ChildExecutionStatus),
  finish: StoredComponent.optional(),
  output: z.unknown().optional(),
  error: StoredError.optional(),
  path: z.array(text),
  spend: StoredCostReport,
  toolCalls: z.array(StoredToolCall),
  steps: z.array(StoredExecutionStep),
};

/** A child execution that ended, as its parent's state keeps it (#263): its own children nested. */
export const StoredEndedChild: z.ZodType<EndedChildRecord> = z.lazy(() =>
  z.object({ ...storedEndedShape, children: z.array(StoredEndedChild) }),
);
