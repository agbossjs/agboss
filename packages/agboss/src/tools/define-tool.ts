import { handedOverOf } from "../app/handed-over.js";
import { AGBossError } from "../core/errors.js";
import type { z } from "zod";
import { pathOf } from "../dto/errors.js";
import type { Tool, ToolInvocationContext, ToolOutput } from "./types.js";
import { isGraphInterrupt } from "@langchain/langgraph";
import { systemClock, type Clock } from "../infrastructure/clock.js";
import { timeoutOn } from "../infrastructure/clock-timeout.js";
import { kilobytes, seconds, type Bytes, type Milliseconds } from "../units/index.js";
import { inCurrentStepEntry } from "../flow/runtime/step-entries.js";

/** How long a tool call may run when its tool sets no `timeout`. */
export const DEFAULT_TOOL_TIMEOUT: Milliseconds = seconds(30);

/** What a model reads of one tool result when neither the tool nor `defaults.tools` bounds it (#336). */
export const DEFAULT_MAX_RESULT_SIZE: Bytes = kilobytes(128);

/**
 * The bound of a workflow's tool results (#336): its `defaults.tools.maxResultSize` (the config,
 * validated: a whole number of bytes from 1), else the built-in.
 */
export const defaultMaxResultSizeOf = (configured: number | undefined): Bytes =>
  configured === undefined ? DEFAULT_MAX_RESULT_SIZE : (configured as Bytes);

/** Function names accepted by OpenAI-compatible providers. */
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

export class InvalidToolNameError extends Error {
  override name = "InvalidToolNameError";
}

/** A tool ran past its `timeout` (its agent's model reads it as a tool error): `timed out after 5 s`. */
export class ToolTimeoutError extends AGBossError {
  static override readonly code: string = "tool.timeout";
  override name = "ToolTimeoutError";
  constructor(timeout: Milliseconds) {
    super(`timed out after ${String(timeout / 1000)} s`);
  }
}

/** TInput / TOutput are the parsed data types; both are inferred from the schemas. */
export interface ToolDefinition<TName extends string, TInput, TOutput> {
  readonly name: TName;
  readonly description: string;
  readonly input: z.ZodType<TInput>;
  readonly output: z.ZodType<TOutput>;
  readonly channel?: string;
  readonly timeout?: Milliseconds;
  readonly maxResultSize?: Bytes;
  readonly run: (input: TInput, ctx: ToolInvocationContext) => Promise<TOutput>;
}

const describeIssues = (error: z.ZodError): string =>
  error.issues.map((issue) => `${pathOf(issue.path)}: ${issue.message}`).join("; ");

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const failure = (message: string, cause?: unknown): ToolOutput<never> =>
  cause === undefined ? { kind: "error", message } : { kind: "error", message, cause };

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
  readonly timeout: Milliseconds;
  readonly clock: Clock | undefined;
}

async function runWithTimeout<TValue>(
  run: (signal: AbortSignal) => Promise<TValue>,
  outer: AbortSignal,
  { timeout: delay, clock }: ToolTimeout,
): Promise<TValue> {
  if (outer.aborted) throw outer.reason as Error; // never start work for a cancelled run
  const reason = (): Error => new ToolTimeoutError(delay);
  const timeout = timeoutOn(clock ?? systemClock, delay, reason);
  const signal = AbortSignal.any([outer, timeout.signal]);
  try {
    return await untilAborted(
      // the body itself is the tool call's running step (#367): it may outlive this race
      Promise.resolve().then(() => inCurrentStepEntry(() => run(signal))),
      signal,
    );
  } finally {
    timeout.release();
  }
}

/** A call outside an agent (a unit test): a signal nobody aborts, a cost nobody records. */
const standaloneCall = (): ToolInvocationContext => ({
  signal: new AbortController().signal,
  reportCost: () => undefined,
});

/** A LangGraph interrupt (a pause), by class or by name across module copies. */
const isInterrupt = (error: unknown): boolean =>
  isGraphInterrupt(error) ||
  (typeof error === "object" &&
    error !== null &&
    "name" in error &&
    error.name === "GraphInterrupt");

/**
 * What a run that threw gives besides a pause: a hand-over rises as it is — a lost lease or a fenced
 * write (#471) stops the loop, nothing goes back to the model —, any other failure is an error result.
 */
function failedRun(error: unknown, signal: AbortSignal | undefined): ToolOutput<never> {
  const handedOver = handedOverOf(error, signal);
  if (handedOver !== undefined) throw handedOver;
  return failure(errorMessage(error), error);
}

/** Declares a tool once: zod input/output, typed `run`, failures turned into error results. */
export function defineTool<TName extends string, TInput, TOutput>(
  definition: ToolDefinition<TName, TInput, TOutput>,
): Tool<TName, TInput, TOutput> {
  if (!TOOL_NAME.test(definition.name)) {
    throw new InvalidToolNameError(
      `Tool name "${definition.name}" must match ${String(TOOL_NAME)}`,
    );
  }
  const timeout = definition.timeout ?? DEFAULT_TOOL_TIMEOUT;
  const invoke = async (
    raw: unknown,
    ctx: ToolInvocationContext = standaloneCall(),
  ): Promise<ToolOutput<TOutput>> => {
    const input = definition.input.safeParse(raw);
    if (!input.success) return failure(`invalid input: ${describeIssues(input.error)}`);
    let produced: unknown;
    try {
      produced = await runWithTimeout(
        (signal) => definition.run(input.data, { ...ctx, signal }),
        ctx.signal,
        { timeout, clock: ctx.clock },
      );
    } catch (error) {
      if (isInterrupt(error)) throw error;
      return failedRun(error, ctx.signal);
    }
    const output = definition.output.safeParse(produced);
    if (!output.success) return failure(`invalid output: ${describeIssues(output.error)}`);
    return { kind: "ok", value: output.data };
  };
  return {
    name: definition.name,
    description: definition.description,
    ...(definition.channel === undefined ? {} : { channel: definition.channel }),
    timeout,
    ...(definition.maxResultSize === undefined ? {} : { maxResultSize: definition.maxResultSize }),
    input: definition.input,
    output: definition.output,
    invoke,
  };
}
