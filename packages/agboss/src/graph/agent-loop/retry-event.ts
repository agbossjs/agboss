import { reportNodeEvent } from "../../flow/observers/execution-event.js";
import { AgentRetryReason } from "../../core/observability.js";
import type { AgentLoopDeps } from "./deps.js";

/** One more try of the agent's own loop: what was wrong, which attempt it was, what the model reads. */
export interface AgentRetry {
  readonly reason: AgentRetryReason;
  /** The attempt that just failed, from 1. */
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly feedback: string;
}

/** `onAgentRetry` of the current step: the agent corrects itself (a throw of an observer never reaches the loop). */
export const reportAgentRetry = (deps: AgentLoopDeps, retry: AgentRetry): Promise<void> =>
  reportNodeEvent((base) =>
    deps.observer?.onAgentRetry({ ...base, agent: deps.agent.name, ...retry }),
  );

export { AgentRetryReason };

/** `onAgentRetry` of a call whose arguments its tool's input check refused: the model reads why and calls again. */
export async function reportInvalidInput(
  deps: AgentLoopDeps,
  tool: { readonly input: { safeParse(value: unknown): { readonly success: boolean } } },
  task: {
    readonly tool: string;
    readonly args: unknown;
    readonly progress?: { readonly validationAttempts: number } | undefined;
  },
): Promise<void> {
  if (tool.input.safeParse(task.args).success) return;
  await reportAgentRetry(deps, {
    reason: AgentRetryReason.InvalidToolInput,
    attempt: (task.progress?.validationAttempts ?? 0) + 1,
    maxAttempts: deps.agent.limits.modelCalls,
    feedback: `invalid arguments for ${task.tool}`,
  });
}
