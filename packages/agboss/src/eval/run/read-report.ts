import { storedUsd } from "../../finops/cost-report.js";
import { z } from "zod";
import { ComponentKind } from "../../flow/runtime/records.js";
import { CheckStatus, EvalCascade } from "../suite/checks.js";
import { ChaosFailure } from "../chaos/chaos-failure.js";
import { CaseComparison } from "./comparison.js";
import {
  EVAL_RUN_KIND,
  EVAL_RUN_SCHEMA_VERSION,
  EvalCheckKind,
  type EvalRunReport,
} from "./report.js";
import { CaseExpectationSchema, DateSchema, ExecutionTraceSchema } from "./trace-schema.js";

/**
 * The one reader of run artifacts (#396 PR 3, #397 S4): a file `agboss eval run --baseline` compares
 * with and `agboss eval show` renders — its `kind`, its `schemaVersion` (5 only; any other
 * version is refused) and every field of `EvalRunReport`, the optional `baseline`
 * comparison and the version 2 `trace` / `expectation` (#397 PR 2) included, validated with zod inside the framework. Fields it does not know are kept, so a newer
 * artifact's additions pass through untouched.
 */

/** What reading an artifact gave: the report, or why the value is not one. */
export type EvalRunReportRead =
  | { readonly kind: "read"; readonly report: EvalRunReport }
  | { readonly kind: "invalid"; readonly reason: string };

const count = z.number().int().nonnegative();

const CheckSchema = z.looseObject({
  check: z.string(),
  kind: z.enum(EvalCheckKind),
  status: z.enum(CheckStatus),
  reason: z.string().optional(),
  skippedBy: z.string().optional(),
  metrics: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
  spentUsd: storedUsd.optional(),
});

const RunSchema = z.looseObject({
  run: z.number().int().positive(),
  threadId: z.string(),
  tenantId: z.string().optional(),
  executionId: z.string().optional(),
  finish: z.string().optional(),
  passed: z.boolean(),
  checks: z.array(CheckSchema),
  error: z.looseObject({ code: z.string(), message: z.string() }).optional(),
  executionUsd: storedUsd,
  judgeUsd: storedUsd,
  totalUsd: storedUsd,
  trace: ExecutionTraceSchema.optional(),
});

const CaseSchema = z.looseObject({
  name: z.string(),
  caseHash: z.string(),
  passed: count,
  runs: count,
  passAtK: z.boolean(),
  passHatK: z.boolean(),
  isUnstable: z.boolean(),
  runResults: z.array(RunSchema),
  expectation: CaseExpectationSchema.optional(),
});

const PassesSchema = z.looseObject({ passed: count, runs: count });

/** `baseline` (#396 PR 3): the run against `--baseline`, what a baseline-diff view reads. */
const ComparisonSchema = z.looseObject({
  file: z.string(),
  configHash: z.string(),
  startedAt: DateSchema,
  runs: z.number().int().positive(),
  cases: z.array(
    z.looseObject({
      name: z.string(),
      comparison: z.enum(CaseComparison),
      baseline: PassesSchema.optional(),
      candidate: PassesSchema.optional(),
    }),
  ),
  regressed: z.array(z.string()),
});

/** `chaos` (#396 PR 6): what `--chaos` injected into the run's model calls. */
const ChaosSchema = z.looseObject({
  rate: z.number(),
  seed: z.number().int(),
  failures: z.array(z.enum(ChaosFailure)),
  calls: count,
  injected: z.looseObject({
    [ChaosFailure.RateLimited]: count,
    [ChaosFailure.Timeout]: count,
    [ChaosFailure.TruncatedResponse]: count,
  }),
});

const ModelUseSchema = z.looseObject({
  component: z.string(),
  kind: z.enum(ComponentKind),
  model: z.string(),
  provider: z.string(),
});

const ComponentSchema = z.looseObject({ name: z.string(), version: z.string() });

const ReportSchema: z.ZodType<EvalRunReport> = z.looseObject({
  kind: z.literal(EVAL_RUN_KIND),
  schemaVersion: z.literal(EVAL_RUN_SCHEMA_VERSION),
  suite: z.string(),
  application: ComponentSchema,
  workflow: ComponentSchema,
  configHash: z.string(),
  start: z.string(),
  environment: z.string(),
  runs: z.number().int().positive(),
  cascade: z.enum(EvalCascade),
  startedAt: DateSchema,
  endedAt: DateSchema,
  cases: z.array(CaseSchema),
  summary: z.looseObject({
    cases: count,
    passAtK: count,
    passHatK: count,
    unstable: count,
    judgeCalls: count,
    skippedByCascade: count,
  }),
  spend: z.looseObject({ executionUsd: storedUsd, judgeUsd: storedUsd, totalUsd: storedUsd }),
  chaos: ChaosSchema.optional(),
  metamorphic: z.boolean().optional(),
  baseline: ComparisonSchema.optional(),
  profile: z.string().optional(),
  agbossVersion: z.string().optional(),
  models: z.array(ModelUseSchema).optional(),
  judges: z.array(ModelUseSchema).optional(),
  piiPolicies: z.array(z.string()).optional(),
});

/** The version this reader reads. */
const READ_VERSIONS: readonly unknown[] = [EVAL_RUN_SCHEMA_VERSION];

/** What the value says it is, whatever else it holds. */
const IdentitySchema = z.looseObject({
  kind: z.unknown().optional(),
  schemaVersion: z.unknown().optional(),
});

const shown = (value: unknown): string => (value === undefined ? "missing" : JSON.stringify(value));

/** Why the value is not an artifact: its kind and version first, then the first bad field. */
function reasonOf(value: unknown, issues: readonly z.core.$ZodIssue[]): string {
  const identity = IdentitySchema.safeParse(value);
  const { kind, schemaVersion: version } = identity.success ? identity.data : {};
  if (kind !== EVAL_RUN_KIND) return `kind is ${shown(kind)}, not "${EVAL_RUN_KIND}"`;
  if (!READ_VERSIONS.includes(version))
    return `schemaVersion ${shown(version)} — this agboss reads ${String(EVAL_RUN_SCHEMA_VERSION)} only`;
  const [issue] = issues;
  return issue === undefined ? "invalid" : `${issue.path.join(".")}: ${issue.message}`;
}

/** The artifact in `value` (parsed JSON), or why it is not one this version reads. */
export function evalRunReportOf(value: unknown): EvalRunReportRead {
  const parsed = ReportSchema.safeParse(value);
  if (parsed.success) return { kind: "read", report: parsed.data };
  return { kind: "invalid", reason: reasonOf(value, parsed.error.issues) };
}
