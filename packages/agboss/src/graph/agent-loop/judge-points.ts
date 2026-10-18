import type { GuardrailInput } from "../../core/observability.js";
import type { ExecutionObserver } from "../../core/observer-hooks.js";
import type { ToolCallRequest } from "./deps.js";
import { reportNodeEvent } from "../../flow/observers/execution-event.js";

/** Where in an agent's loop a judge looks. */
export enum JudgePoint {
  BeforeToolCall = "beforeToolCall",
  AfterToolCall = "afterToolCall",
  BeforeAgentAnswer = "beforeAgentAnswer",
  OnChannelDecision = "onChannelDecision",
}

/** Whose judges look: the tool's own run first, then the agent's. */
export enum JudgeOwner {
  Tool = "tool",
  Agent = "agent",
}

/** One visit of a judge point: where, whose judges, which agent, which call (none before the replyWith). */
export interface JudgeVisit {
  readonly point: JudgePoint;
  readonly owner: JudgeOwner;
  readonly agent: string;
  readonly call?: ToolCallRequest;
  readonly decision?: {
    approved: boolean;
    by?: string;
    feedback?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    overrideArguments?: any;
  };
}

/**
 * The extension points of the move boundary, visited in order: tool judges `beforeToolCall` → agent
 * judges `beforeToolCall` → approval → run → `afterToolCall` (tool, then agent); `beforeAgentAnswer`
 * before the replyWith leaves the loop. Empty here — the judges themselves come with #123.
 */
export type JudgePoints = (visit: JudgeVisit) => Promise<void>;

export const noJudges: JudgePoints = () => Promise.resolve();

/** Visits a point for the tool's judges, then for the agent's. */
// eslint-disable-next-line complexity
export function mergePolicies(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wPolicies: readonly any[] | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  aPolicies: { override: boolean; instances: readonly any[]; disable: readonly any[] } | undefined,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tPolicies?: { override: boolean; instances: readonly any[]; disable: readonly any[] },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any[] {
  const wGuard = wPolicies ?? [];

  const combined = tPolicies?.override
    ? tPolicies.instances
    : [
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        ...(aPolicies?.override ? [] : wGuard),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        ...(aPolicies?.instances ?? []),
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        ...(tPolicies?.instances ?? []),
      ];

  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  const disabled = new Set([...(aPolicies?.disable ?? []), ...(tPolicies?.disable ?? [])]);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  if (disabled.size === 0) return combined as any[];
  // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
  return combined.filter((g) => !disabled.has(g.constructor));
}

/** Tells the observers a guardrail ran: start with what it is shown, end with what it returned. */
async function reportGuardrail<T>(
  observer: ExecutionObserver | undefined,
  name: string,
  input: GuardrailInput,
  run: () => Promise<T>,
): Promise<T> {
  if (observer === undefined) return run();
  await reportNodeEvent((base) => observer.onGuardrailStart?.({ ...base, name, input }));
  const result = await run();
  await reportNodeEvent((base) => observer.onGuardrailEnd?.({ ...base, name, update: result }));
  return result;
}

export async function visitToolThenAgent(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  guardrails: readonly any[] | undefined,
  point: JudgePoint,
  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types, @typescript-eslint/no-explicit-any
  ctx: any,
  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types, @typescript-eslint/no-explicit-any
  decision?: any,
  observer?: ExecutionObserver,
): Promise<void> {
  if (!guardrails) return;
  for (const g of guardrails) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    if (typeof g[point] === "function") {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/prefer-nullish-coalescing
      const gName: string = g.constructor.name || "UnknownGuardrail";
      const onChannel = point === JudgePoint.OnChannelDecision;
      const result: unknown = await reportGuardrail(
        observer,
        gName,
        { point, ctx, decision },
        async (): Promise<unknown> =>
          // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
          (await g[point](onChannel ? decision : ctx, onChannel ? ctx : undefined)) as unknown,
      );
      if (result && typeof result === "object" && "overrideArguments" in result) {
        // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing, @typescript-eslint/no-unsafe-member-access
        if (!ctx.call.args) ctx.call.args = {};
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access
        ctx.call.args = { ...ctx.call.args, ...(result.overrideArguments as object) };
      }
    }
  }
}

export async function visitAgentAnswer(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  guardrails: readonly any[] | undefined,
  // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types, @typescript-eslint/no-explicit-any
  ctx: any,
  observer?: ExecutionObserver,
): Promise<void> {
  if (!guardrails) return;
  for (const g of guardrails) {
    // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
    if (typeof g.beforeAgentAnswer === "function") {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/prefer-nullish-coalescing
      const gName: string = g.constructor.name || "UnknownGuardrail";
      await reportGuardrail(
        observer,
        gName,
        { point: "beforeAgentAnswer", ctx },
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access
        async (): Promise<unknown> => (await g.beforeAgentAnswer(ctx)) as unknown,
      );
    }
  }
}
