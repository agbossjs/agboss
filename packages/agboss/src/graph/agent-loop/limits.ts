import { LimitError } from "../../core/error-families/limit-errors.js";
import { usd } from "../../units/index.js";
import { totalCost, type UsageRecord } from "../../finops/usage.js";
import { countBoundOf } from "../count-limit.js";
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

/** The caps an agent sets (`@Agent({ executionLimits })`), as its settings hold them. */
export interface AgentLimitSettings {
  readonly maxModelCalls?: number | undefined;
  readonly maxToolCalls?: number | undefined;
}

/**
 * `modelCalls` comes from the agent's `executionLimits.maxModelCalls`, `toolCalls` from its `maxToolCalls` — else
 * `defaults.tools.maxToolCalls` — when set; each other is the default.
 */
export function resolveAgentLimits(
  agent: AgentLimitSettings | undefined,
  defaultMaxToolCalls: number | undefined,
): ResolvedAgentLimits {
  // a value that is no count (untyped code, parsed JSON) is a bound of 0: assembly refuses it
  // (`[limits.count-invalid]`, #1373), and a call that got past still stops at the first call
  const bound = (value: number | undefined): number | undefined =>
    value === undefined ? undefined : countBoundOf(value);
  const modelCalls = bound(agent?.maxModelCalls);
  const toolCalls = bound(
    [agent?.maxToolCalls, defaultMaxToolCalls].find((value) => value !== undefined),
  );
  return {
    limits: {
      modelCalls: modelCalls ?? DEFAULT_AGENT_LIMITS.modelCalls,
      toolCalls: toolCalls ?? DEFAULT_AGENT_LIMITS.toolCalls,
    },
    defaulted: [
      ...(modelCalls === undefined ? (["modelCalls"] as const) : []),
      ...(toolCalls === undefined ? (["toolCalls"] as const) : []),
    ],
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
): LimitError.Agent {
  const usage = [...loopUsage(state), ...breach.spent];
  return new LimitError.Agent({
    key: `agents.${breach.agent}.limits.${breach.limit}`,
    limit: breach.max,
    actual: breach.actual,
    path: state.flowPath,
    spentUsd: usd(totalCost(state.usage) + totalCost(breach.spent)),
    usage,
  });
}
