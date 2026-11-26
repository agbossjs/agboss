import { timeText } from "./time-text.js";
import { BudgetScope, BudgetUnit, type BudgetPeriod } from "../../budgets/budget.js";
import { periodWords } from "../../budgets/budget-period.js";
import { bareRecordOf, ComponentKind, type ComponentRecord } from "../../flow/runtime/records.js";
import type { WorkflowRecord } from "../../flow/context/execution-context.js";
import { usd, type Usd } from "../../units/index.js";
import { plainly, type VariantMore } from "./family.js";
import { plainWorkflowOf } from "./step-error-helpers.js";

/**
 * What the `LimitError` variants do besides naming themselves (#1325b): each says its limit and the
 * value that crossed it as a sentence, and derives its `limit`, `actual` and `key` from the facts it
 * is given (`maxSteps`, the callers' own words) so the old call sites keep their shape.
 */

/** `$40`, `$40.05`, `$0.0125`: up to four decimals, no trailing zeros. */
export const dollars = (amount: number): string => `$${amount.toFixed(4).replace(/\.?0+$/, "")}`;

interface Place {
  readonly path?: readonly string[];
  readonly spentUsd?: Usd;
}

/** Where the execution was: none given is the start of nothing, at no cost. */
const placeOf = (given: Place): Required<Place> => ({
  path: given.path ?? [],
  spentUsd: given.spentUsd ?? usd(0),
});

/** The sentence of a limit that is only a count: `Limit <key> = <limit> exceeded (<actual>); path: …; spent $…`. */
export const countedMessageOf = (
  f: Partial<{ key: string; limit: number; actual: number } & Place>,
): string =>
  `Limit ${f.key ?? "?"} = ${String(f.limit ?? 0)} exceeded (${String(f.actual ?? 0)}); ` +
  `path: ${(f.path ?? []).join(" → ")}; spent $${(f.spentUsd ?? 0).toFixed(4)}`;

interface BudgetFacts {
  readonly budget: Pick<ComponentRecord, "name">;
  readonly scope: BudgetScope;
  readonly period?: BudgetPeriod | undefined;
  readonly key: string;
  readonly unit?: BudgetUnit | undefined;
  readonly maxSpend?: Usd | undefined;
  readonly spent: Usd;
  readonly maxTokens?: number | undefined;
  readonly usedTokens?: number | undefined;
}

/** `tenant acme used 120,000 tokens today; tenant-daily-budget allows 100,000`. */
function tokenSentence(breach: BudgetFacts): string {
  const used = String(breach.usedTokens ?? 0);
  const allows = `${breach.budget.name} allows ${String(breach.maxTokens ?? 0)} tokens`;
  const when = breach.period === undefined ? "" : ` ${periodWords(breach.period)}`;
  const who =
    breach.scope === BudgetScope.Tenant
      ? `tenant ${breach.key}`
      : breach.scope === BudgetScope.Execution
        ? `execution ${breach.key}`
        : breach.key;
  return `${who} used ${used} tokens${when}; ${allows}`;
}

/** `tenant acme spent $40.05 today; tenant-daily-budget allows $40`. */
function budgetSentence(breach: BudgetFacts): string {
  if (breach.unit === BudgetUnit.Tokens) return tokenSentence(breach);
  const allows = `${breach.budget.name} allows ${dollars(breach.maxSpend ?? 0)}`;
  const spent = dollars(breach.spent);
  const when = breach.period === undefined ? "" : ` ${periodWords(breach.period)}`;
  switch (breach.scope) {
    case BudgetScope.Tenant:
      return `tenant ${breach.key} spent ${spent}${when}; ${allows}`;
    case BudgetScope.Application:
      return `${breach.key} spent ${spent}${when}; ${allows}`;
    case BudgetScope.Execution:
      return `execution ${breach.key} spent ${spent}; ${allows}`;
  }
}

interface Counts {
  readonly limit?: number;
  readonly actual?: number;
  readonly key?: string;
}

/** The `more` of a counted limit: its derived numbers and key, its place, its extra record details. */
export function counted<T extends object>(
  derive: (facts: T) => Counts & Record<string, unknown>,
  extra: (facts: T) => Record<string, unknown> = () => ({}),
  force = false,
): VariantMore {
  return {
    ...(force ? { force: true } : {}),
    hidden: ["path", "spentUsd"],
    keep: (facts: T & Place) => ({ ...derive(facts), ...placeOf(facts) }),
    extra: (facts: T & Place) => ({ ...extra(facts) }),
  };
}

export const LIMIT_SPECS = {
  budget: plainly(
    [
      (f: BudgetFacts) => budgetSentence(f),
      undefined,
      {
        hidden: ["path", "spentUsd"],
        keep: (f: Partial<BudgetFacts>) => {
          const unit = f.unit ?? BudgetUnit.Usd;
          return {
            unit,
            usedTokens: f.usedTokens ?? 0,
            ...(f.budget === undefined
              ? {}
              : { budget: bareRecordOf(f.budget.name, ComponentKind.Budget) }),
            limit: unit === BudgetUnit.Tokens ? (f.maxTokens ?? 0) : (f.maxSpend ?? 0),
            actual: unit === BudgetUnit.Tokens ? (f.usedTokens ?? 0) : (f.spent ?? 0),
          };
        },
        extra: (f: Partial<BudgetFacts>) =>
          f.budget === undefined
            ? {}
            : { budget: bareRecordOf(f.budget.name, ComponentKind.Budget) },
      },
    ],
    ["budget"],
    "a budget is exhausted",
  ),
  deadline: plainly(
    [
      (f: { deadline?: number; deadlineAt?: Date }) =>
        `the execution ran past its deadline of ${String((f.deadline ?? 0) / 1000)} s (at ${timeText(f.deadlineAt, "")})`,
      undefined,
      counted((f: { deadline: number }) => ({
        key: "deadline",
        limit: f.deadline,
        actual: f.deadline,
        // the deadline passed; how far is not measured here, so the limit and the actual agree
      })),
    ],
    ["deadline"],
    "the execution ran past its deadline",
  ),
  steps: plainly(
    [
      (f: { workflow?: string; limit?: number; actual?: number }) =>
        `${f.workflow ?? ""} took ${String(f.actual ?? 0)} steps; its maxSteps is ${String(f.limit ?? 0)}`,
      undefined,
      counted(
        (f: { workflowRecord?: WorkflowRecord; workflow?: string; maxSteps?: number }) => ({
          key: "maxSteps",
          workflow: f.workflow ?? f.workflowRecord?.name ?? "",
          limit: f.maxSteps ?? 0,
          actual: (f.maxSteps ?? 0) + 1,
          steps: (f.maxSteps ?? 0) + 1,
          ...(f.workflowRecord === undefined
            ? {}
            : { workflowRecord: plainWorkflowOf(f.workflowRecord) }),
        }),
        (f) =>
          f.workflowRecord === undefined ? {} : { workflow: plainWorkflowOf(f.workflowRecord) },
        true,
      ),
    ],
    ["workflow"],
    "the execution took more steps than its workflow allows",
  ),
  visits: plainly(
    [
      (f: { nodeId?: string; limit?: number; actual?: number }) =>
        `${f.nodeId ?? ""} was visited ${String(f.actual ?? 0)} times; its maxVisits is ${String(f.limit ?? 0)}`,
      undefined,
      counted(
        (f: { component?: ComponentRecord; nodeId?: string; maxVisits?: number }) => {
          const nodeId = f.nodeId ?? f.component?.name ?? "";
          return {
            nodeId,
            key: `${nodeId}.maxVisits`,
            limit: f.maxVisits ?? 0,
            actual: (f.maxVisits ?? 0) + 1,
            visits: (f.maxVisits ?? 0) + 1,
          };
        },
        (f) => (f.component === undefined ? {} : { component: f.component }),
      ),
    ],
    ["nodeId"],
    "a node was visited more often than its limit allows",
  ),
  depth: plainly(
    [
      (f: { workflow?: string; actual?: number; limit?: number }) =>
        `${f.workflow ?? ""} went ${String(f.actual ?? 0)} levels deep; its maxDepth is ${String(f.limit ?? 0)}`,
      undefined,
      counted(
        (f: { workflowRecord?: WorkflowRecord; workflow?: string; maxDepth?: number }) => ({
          key: "maxDepth",
          workflow: f.workflow ?? f.workflowRecord?.name ?? "",
          limit: f.maxDepth ?? 0,
          actual: (f.maxDepth ?? 0) + 1,
          depth: (f.maxDepth ?? 0) + 1,
          ...(f.workflowRecord === undefined
            ? {}
            : { workflowRecord: plainWorkflowOf(f.workflowRecord) }),
        }),
        (f) =>
          f.workflowRecord === undefined ? {} : { workflow: plainWorkflowOf(f.workflowRecord) },
        true,
      ),
    ],
    ["workflow"],
    "a recursion went deeper than its workflow allows",
  ),
};
