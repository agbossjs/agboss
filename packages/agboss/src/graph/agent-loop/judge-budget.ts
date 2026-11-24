import type { UsageRecord } from "../../finops/usage.js";
import type { AgentLoopDeps } from "./deps.js";
import { loopUsage, type AgentLoopStateType } from "./state.js";

/**
 * What runs right before each model call of a judge (#1290): the budgets are checked with the loop's
 * spend and the judges' so far (the files' transcriptions and the judges before, not yet tallied), so
 * an exhausted budget stops the next call — the first judge's spend counts against the second's.
 */
export const judgeBudgetCheckOf =
  (state: AgentLoopStateType, deps: AgentLoopDeps, judged: readonly UsageRecord[]) => (): void => {
    deps.budgets.check([...state.usage, ...judged], state.flowPath, [
      ...loopUsage(state),
      ...judged,
    ]);
  };
