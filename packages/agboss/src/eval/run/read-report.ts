import { z } from "zod";
import { CheckStatus, EvalCascade } from "../suite/checks.js";
import { CaseComparison } from "./comparison.js";
import { EVAL_RUN_KIND, EVAL_RUN_SCHEMA_VERSION, type EvalRunReport } from "./report.js";

/**
 * The one reader of run artifacts (#396 PR 3, #397 S4): a file `agboss eval run --baseline` compares
 * with and `agboss eval show` renders — its `kind`, its `schemaVersion` (a version this reader does
 * not know is refused) and every field of `EvalRunReport`, the optional `baseline` comparison
 * included, validated with zod inside the framework. Fields it does not know are kept, so a newer
 * artifact's additions pass through untouched.
 */

/** What reading an artifact gave: the report, or why the value is not one. */
export type EvalRunReportRead =
  | { readonly kind: "read"; readonly report: EvalRunReport }
  | { readonly kind: "invalid"; readonly reason: string };

const count = z.number().int().nonnegative();

const CheckSchema = z.looseObject({
  check: z.string(),
  status: z.enum(CheckStatus),
  reason: z.string().optional(),
  skippedBy: z.string().optional(),
  metrics: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
  spentUsd: z.number().optional(),
});

const RunSchema = z.looseObject({
  run: z.number().int().positive(),
  threadId: z.string(),
  executionId: z.string().optional(),
  finish: z.string().optional(),
  passed: z.boolean(),
  checks: z.array(CheckSchema),
  error: z.looseObject({ code: z.string(), message: z.string() }).optional(),
  spentUsd: z.number(),
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
});

const PassesSchema = z.looseObject({ passed: count, runs: count });

/** `baseline` (#396 PR 3): the run against `--baseline`, what a baseline-diff view reads. */
const ComparisonSchema = z.looseObject({
  file: z.string(),
  configHash: z.string(),
  startedAt: z.string(),
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
  startedAt: z.string(),
  endedAt: z.string(),
  cases: z.array(CaseSchema),
  summary: z.looseObject({
    cases: count,
    passAtK: count,
    passHatK: count,
    unstable: count,
    judgeCalls: count,
    skippedByCascade: count,
  }),
  spend: z.looseObject({ totalUsd: z.number() }),
  baseline: ComparisonSchema.optional(),
});

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
  if (version !== EVAL_RUN_SCHEMA_VERSION)
    return `schemaVersion ${shown(version)} — this agboss reads ${String(EVAL_RUN_SCHEMA_VERSION)}`;
  const [issue] = issues;
  return issue === undefined ? "invalid" : `${issue.path.join(".")}: ${issue.message}`;
}

/** The artifact in `value` (parsed JSON), or why it is not one this version reads. */
export function evalRunReportOf(value: unknown): EvalRunReportRead {
  const parsed = ReportSchema.safeParse(value);
  if (parsed.success) return { kind: "read", report: parsed.data };
  return { kind: "invalid", reason: reasonOf(value, parsed.error.issues) };
}
