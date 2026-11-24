import { storedUsd } from "../../finops/cost-report.js";
import { z } from "zod";
import { CompensationReason, CompensationStatus } from "../../flow/compensation.js";
import { ChildExecutionStatus } from "../../flow/runtime/child-records.js";
import { ComponentKind } from "../../flow/runtime/records.js";
import { ToolCallStatus } from "../../flow/runtime/tool-calls.js";
import { GuardrailSide } from "../../components/policy-decorators.js";
import { ExecutionStatus } from "../../app/types.js";
import { PauseResolution } from "../../infrastructure/pause-record.js";
import type { EvalCaseExpectation, EvalChildTrace, EvalExecutionTrace } from "./trace.js";

/**
 * The run artifact's trajectories, validated by its one reader (#397 PR 2): each run's `trace` and
 * each case's `expectation` of a version 2 artifact. Unknown fields are kept, like the rest of it.
 */

/** A timestamp as a trace holds it: a `Date`, written to the file as ISO 8601 text and read back. */
export const DateSchema = z.union([z.date(), z.iso.datetime().transform((text) => new Date(text))]);

const count = z.number().int().nonnegative();

const ErrorSchema = z.looseObject({ code: z.string(), message: z.string() });

const metrics = z.record(z.string(), z.union([z.number(), z.string(), z.boolean()]));

const StepSchema = z.looseObject({
  component: z.string(),
  kind: z.enum(ComponentKind),
  nodeId: z.string(),
  visitNumber: count,
  copyNumber: count,
  itemIndex: count.optional(),
  inputHash: z.string(),
  validationAttempts: count,
  modelCalls: z.array(
    z.looseObject({
      caller: z.string(),
      model: z.string(),
      inputTokens: count,
      outputTokens: count,
      cacheReadTokens: count,
      costUsd: storedUsd,
    }),
  ),
  toolCalls: z.array(
    z.looseObject({
      tool: z.string(),
      toolLoopIteration: count.optional(),
      status: z.enum(ToolCallStatus),
      input: z.unknown(),
      output: z.unknown().optional(),
      error: ErrorSchema.optional(),
      isResultTruncated: z.boolean(),
      validationAttempts: count,
    }),
  ),
  guardrailDecisions: z.array(
    z.looseObject({
      guardrail: z.string(),
      side: z.enum(GuardrailSide),
      isBlocked: z.boolean(),
      probability: z.number(),
    }),
  ),
  judgeVerdicts: z.array(
    z.looseObject({
      judge: z.string(),
      attempt: count,
      passed: z.boolean(),
      reason: z.string().optional(),
      metrics: metrics.optional(),
    }),
  ),
  spentUsd: storedUsd,
  startedAt: DateSchema,
  endedAt: DateSchema,
  error: ErrorSchema.optional(),
});

const trajectoryShape = {
  executionId: z.string(),
  path: z.array(z.string()),
  steps: z.array(StepSchema),
  handledErrors: z.array(z.looseObject({ error: ErrorSchema, at: z.string(), by: z.string() })),
  pauses: z.array(
    z.looseObject({
      nodeId: z.string(),
      target: z.string(),
      resolution: z.enum(PauseResolution),
      actor: z.looseObject({ id: z.string(), orgId: z.string().optional() }).optional(),
      output: z.unknown().optional(),
    }),
  ),
  compensations: z.array(
    z.looseObject({
      compensated: z.string(),
      compensator: z.string(),
      reason: z.enum(CompensationReason),
      status: z.enum(CompensationStatus),
      error: ErrorSchema.optional(),
    }),
  ),
  // a child's trace nests its own children: the schema refers to itself
  children: z.array(z.lazy((): z.ZodType<EvalChildTrace> => ChildSchema)),
  finish: z.string().optional(),
  output: z.unknown().optional(),
};

const ChildSchema: z.ZodType<EvalChildTrace> = z.looseObject({
  ...trajectoryShape,
  workflow: z.string(),
  status: z.enum(ChildExecutionStatus),
  launchedBy: z.string(),
  itemIndex: count.optional(),
  error: ErrorSchema.optional(),
});

/** A run's `trace`. */
export const ExecutionTraceSchema: z.ZodType<EvalExecutionTrace> = z.looseObject({
  ...trajectoryShape,
  status: z.enum(ExecutionStatus),
});

/** A case's `expectation`. */
export const CaseExpectationSchema: z.ZodType<EvalCaseExpectation> = z.looseObject({
  requiredTools: z.array(z.looseObject({ tool: z.string(), input: z.unknown().optional() })),
  forbiddenTools: z.array(z.string()),
  invariantTools: z.array(z.string()),
  checks: z.array(z.string()),
});
