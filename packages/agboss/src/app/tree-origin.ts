import type { ExecutionStateType } from "../flow/runtime/state.js";
import { runConfig } from "../run/paused.js";
import { readingGraphOf } from "../run/run-budgets.js";
import type { AppDeps } from "./app-deps.js";
import type { ObservedExecution } from "./run-events.js";

/**
 * A trusted mesh request's origin on the later legs of its execution (#398 PR 2b, S5): a resume or a
 * recovery names the tree by its records only, so its execution events would lack the `origin` its
 * first leg carried — it is read from the root's checkpointed contexts, where the first leg kept it.
 */
export async function withTreeOrigin<TState extends ObservedExecution>(
  deps: AppDeps,
  state: TState,
): Promise<TState> {
  const snapshot = await readingGraphOf(deps).getState(runConfig(state.runId));
  // LangGraph boundary: a checkpoint's values are the flow's own state
  const values = snapshot.values as Partial<ExecutionStateType>;
  const origin = values.contexts?.mesh?.trusted?.origin;
  return origin === undefined ? state : { ...state, origin };
}
