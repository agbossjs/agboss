import type { Class } from "../components/injection.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { AgentFailedError, GuardFailedError } from "../graph/errors.js";
import { BudgetExceededError, LimitExceededError } from "../graph/limits.js";
import { RouterFailedError } from "../flow/runtime/router-error.js";
import { ActionFailedError } from "../flow/runtime/errors.js";
import { GraphRuleError } from "../graph/rule-error.js";

/** The name a component has in executions, routes and results: its `name` (its node id). */
export const nodeNameOf = (target: Class): string =>
  declarationOf(target)?.options.name ?? target.name;

/** What a failed run says about itself: its codes and the nodes it names, along the cause chain. */
export interface FailureFacts {
  readonly codes: readonly string[];
  readonly nodes: readonly string[];
}

function codesOf(error: Error): string[] {
  if (error instanceof GraphRuleError) return error.violations.map((item) => item.code);
  // a budget by its name (`tenant-daily-budget`), any other limit by what it is keyed by (`maxSteps`)
  if (error instanceof BudgetExceededError) return [error.budget.name, error.code];
  if (error instanceof LimitExceededError) return [error.key, error.code];
  return "code" in error && typeof error.code === "string" ? [error.code] : [];
}

function nodesOf(error: Error): string[] {
  if (error instanceof RouterFailedError) return [error.nodeId];
  if (error instanceof AgentFailedError) return [error.agent];
  if (error instanceof ActionFailedError) return [error.nodeId];
  if (error instanceof GuardFailedError) return [error.guard];
  if (error instanceof LimitExceededError) return error.path.slice(-1);
  if (error instanceof GraphRuleError) return error.violations.flatMap((item) => item.nodes);
  return [];
}

/** Codes and nodes of an error and every error it was caused by. */
export function failureFactsOf(error: unknown): FailureFacts {
  const codes: string[] = [];
  const nodes: string[] = [];
  let current: unknown = error;
  while (current instanceof Error) {
    codes.push(...codesOf(current));
    nodes.push(...nodesOf(current));
    current = current.cause;
  }
  return { codes, nodes };
}
