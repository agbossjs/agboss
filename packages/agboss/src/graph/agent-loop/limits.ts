import { totalCost, type UsageRecord } from "../../finops/usage.js";
import { countBoundOf } from "../count-limit.js";
import { LimitExceededError } from "../limits.js";
import { loopUsage, type AgentLoopStateType } from "./state.js";

/**
 * What one call of an agent may do, counted from the flow handing it work to its replyWith: model calls
 * and tool calls. (`judgeSendBacks` joins them with the judges, #123.)
 */
export interface AgentLoopLimits {
  readonly modelCalls: number;
  readonly toolCalls: number;
}

/** The name of one agent limit, as its boundary key ends: `agents.<name>.limits.<limit>`. */
export type AgentLimit = keyof AgentLoopLimits;

export const DEFAULT_AGENT_LIMITS: AgentLoopLimits = { modelCalls: 12, toolCalls: 20 };

/** An agent's limits and which of them are the framework's defaults (shown as `(default)`). */
export interface ResolvedAgentLimits {
  readonly limits: AgentLoopLimits;
  readonly defaulted: readonly AgentLimit[];
}

/**
 * Until `@Agent({ limits })` (#152): `toolCalls` comes from `maxToolCalls` — the agent's own, else
 * `defaults.tools.maxToolCalls` — when set; everything else is the default.
 */
export function resolveAgentLimits(
  agentMaxToolCalls: number | undefined,
  defaultMaxToolCalls: number | undefined,
): ResolvedAgentLimits {
  const set = [agentMaxToolCalls, defaultMaxToolCalls].find((value) => value !== undefined);
  // a value that is no count (untyped code, parsed JSON) is a bound of 0: assembly refuses it
  // (`[limits.count-invalid]`, #1373), and a call that got past still stops at the first tool call
  const toolCalls = set === undefined ? undefined : countBoundOf(set);
  return {
    limits: { ...DEFAULT_AGENT_LIMITS, ...(toolCalls === undefined ? {} : { toolCalls }) },
    defaulted: toolCalls === undefined ? ["modelCalls", "toolCalls"] : ["modelCalls"],
  };
}

/** What crossed an agent limit: the agent, the limit, the count it would reach, spend not in state yet. */
export interface AgentLimitBreach {
  readonly agent: string;
  readonly limit: AgentLimit;
  readonly max: number;
  readonly actual: number;
  readonly spent: readonly UsageRecord[];
}

/** Fails the run at an agent limit; the loop's spend so far travels with the error to the ledger. */
export function agentLimitError(
  state: AgentLoopStateType,
  breach: AgentLimitBreach,
): LimitExceededError {
  const usage = [...loopUsage(state), ...breach.spent];
  return new LimitExceededError({
    key: `agents.${breach.agent}.limits.${breach.limit}`,
    limit: breach.max,
    actual: breach.actual,
    path: state.flowPath,
    spentUsd: totalCost(state.usage) + totalCost(breach.spent),
    usage,
  });
}
