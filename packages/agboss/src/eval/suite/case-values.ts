import type { Class } from "../../components/injection.js";
import { DtoValidationError, type DtoIssue } from "../../dto/errors.js";
import { validate } from "../../dto/schema.js";
import { NodeKind } from "../../flow/ast.js";
import {
  executionFieldsOf,
  tenantFieldsOf,
  type ExecutionContextClass,
  type TenantContextClass,
} from "../../flow/context/context-values.js";
import { declarationOf } from "../../flow/decorators/declaration.js";
import { startInputIssuesOf } from "../../flow/runtime/start-input-issues.js";
import type { EvalCase, EvalPastTurn, EvalTurn } from "./cases.js";
import type { EvalCaseIssue } from "./errors.js";

/**
 * The values of a suite's cases (#396), checked before anything runs: `tenant` / `execution`
 * against the application's context classes (as `app.execute` checks them), each turn's and
 * variant's input against the suite's start, each past turn's input against its start and its output
 * against its finish's `output` — every issue with its path, never a value.
 */

/** The context classes of the suite's application. */
export interface CaseContexts {
  readonly tenantContext: TenantContextClass;
  readonly executionContext: ExecutionContextClass;
}

/** `prefix` + an issue's own path (`turns[0]` + `text` → `turns[0].text`). */
const joined = (prefix: string, path: string): string =>
  path === "(root)" ? prefix : path.startsWith("[") ? `${prefix}${path}` : `${prefix}.${path}`;

const prefixed = (prefix: string, issues: readonly DtoIssue[]): DtoIssue[] =>
  issues.map((issue) => ({ path: joined(prefix, issue.path), reason: issue.reason }));

/** The issues a validation throws, as data. */
function issuesOf(prefix: string, check: () => unknown): DtoIssue[] {
  try {
    check();
    return [];
  } catch (error) {
    if (!(error instanceof DtoValidationError)) throw error;
    return prefixed(prefix, error.issues);
  }
}

const isKind = (cls: Class, kind: NodeKind): boolean => declarationOf(cls)?.kind === kind;

function turnIssues(start: Class, turns: readonly EvalTurn[], field: string): DtoIssue[] {
  return turns.flatMap((written, index) =>
    prefixed(`${field}[${String(index)}]`, startInputIssuesOf(start, written.input)),
  );
}

function pastTurnIssues(past: EvalPastTurn, prefix: string): DtoIssue[] {
  const { start, finish } = past;
  const found: DtoIssue[] = [];
  if (isKind(start, NodeKind.Start))
    found.push(...prefixed(`${prefix}.input`, startInputIssuesOf(start, past.input)));
  else found.push({ path: `${prefix}.start`, reason: `${start.name} is not a @WorkflowStart` });
  const declaration = declarationOf(finish);
  if (declaration?.kind === NodeKind.Finish) {
    const { output } = declaration.options;
    found.push(...issuesOf(`${prefix}.output`, () => validate(output, past.output)));
  } else
    found.push({ path: `${prefix}.finish`, reason: `${finish.name} is not a @WorkflowFinish` });
  return found;
}

/** Every issue of one case. */
function caseIssues(start: Class, contexts: CaseContexts, written: EvalCase): DtoIssue[] {
  const found: DtoIssue[] = [
    ...issuesOf("tenant", () => tenantFieldsOf(contexts.tenantContext, written.tenant)),
    ...issuesOf("execution", () => executionFieldsOf(contexts.executionContext, written.execution)),
    ...(written.history ?? []).flatMap((past, index) =>
      pastTurnIssues(past, `history[${String(index)}]`),
    ),
    ...turnIssues(start, written.turns, "turns"),
    ...turnIssues(start, written.variants ?? [], "variants"),
  ];
  if (written.turns.length === 0)
    found.push({ path: "turns", reason: "a case runs at least one turn" });
  return found;
}

/** Every issue of every case of a suite, each naming its case. */
export const caseValueIssues = (
  start: Class,
  contexts: CaseContexts,
  cases: readonly EvalCase[],
): readonly EvalCaseIssue[] =>
  cases.flatMap((written) =>
    caseIssues(start, contexts, written).map((issue) => ({ case: written.name, ...issue })),
  );
