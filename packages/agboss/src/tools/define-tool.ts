import { AGBossError } from "../core/errors.js";
import type { z } from "zod";
import { pathOf } from "../dto/errors.js";
import type { Tool, ToolCallContext, ToolOutput } from "./types.js";
import { isGraphInterrupt } from "@langchain/langgraph";
import { systemClock, type Clock } from "../infrastructure/clock.js";
import { timeoutOn, waitOf } from "../infrastructure/clock-timeout.js";

export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/** Function names accepted by OpenAI-compatible providers. */
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export class InvalidToolNameError extends Error {
  override name = "InvalidToolNameError";
}

/** A tool ran past its `timeoutMs` (its agent's model reads it as a tool error). */
export class ToolTimeoutError extends AGBossError {
  static override readonly code: string = "tool.timeout";
  override name = "ToolTimeoutError";
  constructor(timeoutMs: number) {
    super(`timed out after ${String(timeoutMs)} ms`);
  }
}

/** TInput / TOutput are the parsed data types; both are inferred from the schemas. */
export interface ToolDefinition<TName extends string, TInput, TOutput> {
  readonly name: TName;
  readonly description: string;
  readonly input: z.ZodType<TInput>;
  readonly output: z.ZodType<TOutput>;
  readonly channel?: string;
  readonly timeoutMs?: number;
  readonly run: (input: TInput, ctx: ToolCallContext) => Promise<TOutput>;
}

const describeIssues = (error: z.ZodError): string =>
  error.issues.map((issue) => `${pathOf(issue.path)}: ${issue.message}`).join("; ");

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const failure = (message: string): ToolOutput<never> => ({ kind: "error", message });

/** Rejects when the signal aborts, even if the work ignores the signal. */
function untilAborted<TValue>(work: Promise<TValue>, signal: AbortSignal): Promise<TValue> {
  return new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => {
      reject(signal.reason as Error);
    });
    work.then(resolve, reject);
  });
}

/** The tool's timeout on the clock (the application's; none given → the system's). */
interface ToolTimeout {
  readonly timeoutMs: number;
  readonly clock: Clock | undefined;
}

async function runWithTimeout<TValue>(
  run: (signal: AbortSignal) => Promise<TValue>,
  outer: AbortSignal,
  { timeoutMs, clock }: ToolTimeout,
): Promise<TValue> {
  if (outer.aborted) throw outer.reason as Error; // never start work for a cancelled run
  const reason = (): Error => new ToolTimeoutError(timeoutMs);
  const timeout = timeoutOn(clock ?? systemClock, waitOf(timeoutMs), reason);
  const signal = AbortSignal.any([outer, timeout.signal]);
  try {
    return await untilAborted(
      Promise.resolve().then(() => run(signal)),
      signal,
    );
  } finally {
    timeout.release();
  }
}

/** A call outside an agent (a unit test): a signal nobody aborts, a cost nobody records. */
const standaloneCall = (): ToolCallContext => ({
  signal: new AbortController().signal,
  reportCost: () => undefined,
});

/** Declares a tool once: zod input/output, typed `run`, failures turned into error results. */
export function defineTool<TName extends string, TInput, TOutput>(
  definition: ToolDefinition<TName, TInput, TOutput>,
): Tool<TName, TInput, TOutput> {
  if (!TOOL_NAME.test(definition.name)) {
    throw new InvalidToolNameError(
      `Tool name "${definition.name}" must match ${String(TOOL_NAME)}`,
    );
  }
  const timeoutMs = definition.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
  const invoke = async (
    raw: unknown,
    ctx: ToolCallContext = standaloneCall(),
  ): Promise<ToolOutput<TOutput>> => {
    const input = definition.input.safeParse(raw);
    if (!input.success) return failure(`invalid input: ${describeIssues(input.error)}`);
    let produced: unknown;
    try {
      produced = await runWithTimeout(
        (signal) => definition.run(input.data, { ...ctx, signal }),
        ctx.signal,
        { timeoutMs, clock: ctx.clock },
      );
    } catch (error) {
      if (
        isGraphInterrupt(error) ||
        (error && typeof error === "object" && "name" in error && error.name === "GraphInterrupt")
      ) {
        throw error;
      }
      return failure(errorMessage(error));
    }
    const output = definition.output.safeParse(produced);
    if (!output.success) return failure(`invalid output: ${describeIssues(output.error)}`);
    return { kind: "ok", value: output.data };
  };
  return {
    name: definition.name,
    description: definition.description,
    ...(definition.channel === undefined ? {} : { channel: definition.channel }),
    timeoutMs,
    input: definition.input,
    output: definition.output,
    invoke,
  };
}
