import type { z } from "zod";
import type { CallJudge, Judge, LoopTool, ResultJudge, ToolOutcome } from "./types.js";

/** How a prototype tool is declared: typed input, a run, optional approval and judges. */
export interface ToolSpec<TInput> {
  readonly name: string;
  readonly input: z.ZodType<TInput>;
  readonly needsApproval?: boolean;
  readonly beforeCall?: readonly CallJudge[];
  readonly afterCall?: readonly ResultJudge[];
  run(input: TInput, signal: AbortSignal | undefined): Promise<string>;
}

/** Arguments are checked at the boundary; failures come back to the model as recoverable results. */
export function defineTool<TInput>(spec: ToolSpec<TInput>): LoopTool {
  return {
    name: spec.name,
    needsApproval: spec.needsApproval ?? false,
    beforeCall: spec.beforeCall ?? [],
    afterCall: spec.afterCall ?? [],
    async execute(args, signal): Promise<ToolOutcome> {
      const parsed = spec.input.safeParse(args);
      if (!parsed.success) {
        return { kind: "error", code: "tool.invalid-input", text: parsed.error.message };
      }
      try {
        return { kind: "ok", text: await spec.run(parsed.data, signal) };
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return { kind: "error", code: "tool.failed", text };
      }
    },
  };
}

/** A code judge: deterministic, no model. */
export function codeJudge<TMove, TVerdict>(
  name: string,
  maxRevisions: number,
  decide: (move: TMove) => TVerdict,
): Judge<TMove, TVerdict> {
  return { name, maxRevisions, judge: (move) => Promise.resolve(decide(move)) };
}
