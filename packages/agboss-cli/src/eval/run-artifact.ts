import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CheckStatus, EvalCascade } from "agboss/eval";
import { EVAL_RUN_KIND, EVAL_RUN_SCHEMA_VERSION, type EvalRunReport } from "agboss/internal";
import { z } from "zod";
import type { CommandContext } from "../cli/context.js";
import { CliError } from "../cli/errors.js";

/**
 * A run artifact read back for `agboss eval show <run.json>` (#397 PR 1): its `kind`, its
 * `schemaVersion` (a version this CLI does not know is refused) and every field the report shows,
 * validated before anything renders. Fields it does not know are kept, so a newer artifact's
 * additions pass through `--json` untouched.
 */

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
});

const invalid = (file: string, why: string): CliError =>
  new CliError(
    "usage",
    "eval.run-invalid",
    `${file} is not a run artifact this agboss reads: ${why}`,
  );

/** What the file says it is, whatever else it holds. */
const IdentitySchema = z.looseObject({
  kind: z.unknown().optional(),
  schemaVersion: z.unknown().optional(),
});

const shown = (value: unknown): string => (value === undefined ? "missing" : JSON.stringify(value));

/** Why the parsed JSON is not an artifact: its kind and version first, then the first bad field. */
function reasonOf(value: unknown, issues: readonly z.core.$ZodIssue[]): string {
  const identity = IdentitySchema.safeParse(value);
  const { kind, schemaVersion: version } = identity.success ? identity.data : {};
  if (kind !== EVAL_RUN_KIND) return `kind is ${shown(kind)}, not "${EVAL_RUN_KIND}"`;
  if (version !== EVAL_RUN_SCHEMA_VERSION)
    return `schemaVersion ${shown(version)} — this agboss reads ${String(EVAL_RUN_SCHEMA_VERSION)}`;
  const [issue] = issues;
  return issue === undefined ? "invalid" : `${issue.path.join(".")}: ${issue.message}`;
}

/** The artifact at `path` (relative to the working directory), validated. */
export function readRunArtifact(context: CommandContext, path: string): EvalRunReport {
  const file = resolve(context.io.cwd, path);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    throw new CliError("usage", "eval.run-not-found", `no run artifact at ${path}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw invalid(path, "not JSON");
  }
  const parsed = ReportSchema.safeParse(value);
  if (!parsed.success) throw invalid(path, reasonOf(value, parsed.error.issues));
  return parsed.data;
}
