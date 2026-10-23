import type { z } from "zod";
import type { Clock } from "../infrastructure/clock.js";
import type { Bytes, Milliseconds } from "../units/index.js";

/**
 * What the framework hands its own tool wrapper per call (internal, #280): the call's signal (the
 * execution's, the tool's timeout) and where a paid built-in tool (a knowledge-base search) reports
 * its cost. A project's tool gets nothing besides its input — the execution comes through
 * `deps: [ExecutionContext]`.
 */
export interface ToolInvocationContext {
  readonly signal: AbortSignal;
  /** The application's clock: the tool's `timeout` runs on it (default: the system's, #262). */
  readonly clock?: Clock;
  /** USD of this call; it counts against the budgets as the tool's spend. */
  readonly reportCost: (usd: number) => void;
}

/** Tool failures are values, not exceptions: the model sees them and can recover. */
export type ToolOutput<TOutput> =
  | { readonly kind: "ok"; readonly value: TOutput }
  | {
      readonly kind: "error";
      readonly message: string;
      /** What the tool threw (a timeout: `ToolTimeoutError`); absent for a failed input or output check. */
      readonly cause?: unknown;
    };

/** One shape for every tool — own functions and MCP facades alike. */
export interface Tool<TName extends string = string, TInput = unknown, TOutput = unknown> {
  readonly name: TName;
  readonly description: string;
  readonly channel?: string;
  /** How long one call may run. */
  readonly timeout: Milliseconds;
  /** The tool's own bound on its rendered result (#336); none → its workflow's `defaults.tools`. */
  readonly maxResultSize?: Bytes;
  readonly input: z.ZodType<TInput>;
  readonly output: z.ZodType<TOutput>;
  readonly invoke: (raw: unknown, ctx?: ToolInvocationContext) => Promise<ToolOutput<TOutput>>;
  /** Who reported costs are billed to (default `tool:<name>`), e.g. `rag:<name>` → category retrieval. */
  readonly costCaller?: string;
}

export type AnyTool = Tool;
