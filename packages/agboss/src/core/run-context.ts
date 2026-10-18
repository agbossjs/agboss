import type { RunnableConfig } from "@langchain/core/runnables";
import { WorkflowCancelledError } from "./errors.js";
import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";
import { Clock, systemClock } from "../infrastructure/clock.js";

/** The id of one run (one `execute`, kept by its resumes) — not the conversation thread. */
export type RunId = string & { readonly __brand: "RunId" };

/** Marks a string as a run id (the framework's own ids; tests building a context). */
export const runIdOf = (id: string): RunId => id as RunId;

/**
 * The run as the framework's own code knows it (internal; projects read `ExecutionContext`, #280):
 * built once per `execute` / `resume` and the same for every node of the run.
 */
export interface RunContext {
  /** Unique per run; the same after a resume. */
  readonly runId: RunId;
  /** The conversation the run belongs to (`ExecutionOutput.thread`). */
  readonly threadId: string;
  /** Aborted by `app.cancel(thread)` or by the caller's own `signal`. */
  readonly signal: AbortSignal;
  /** `execute(…, { metadata })`, kept by the run's resumes. */
  readonly metadata: Readonly<Record<string, string>>;
  /** Who the thread belongs to (`execute(…, { ownerId })`); only that owner may continue it. */
  readonly ownerId?: string;
  /** The tenant the run works for (#261): `"default"` when it names none. */
  readonly tenantId: string;
  /** The validated input of the workflow start the run began at (`{}` when unknown); kept by its resumes. */
  readonly input: Readonly<Record<string, unknown>>;
}

/** A run context with defaults: its own thread, the default tenant, a signal nobody aborts, no metadata, no input. */
export function newRunContext(context: {
  readonly runId: string;
  readonly threadId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly metadata?: Readonly<Record<string, string>> | undefined;
  readonly ownerId?: string | undefined;
  readonly tenantId?: string | undefined;
  readonly input?: Readonly<Record<string, unknown>> | undefined;
}): RunContext {
  return {
    runId: runIdOf(context.runId),
    threadId: context.threadId ?? context.runId,
    signal: context.signal ?? new AbortController().signal,
    metadata: context.metadata ?? {},
    input: context.input ?? {},
    tenantId: context.tenantId ?? DEFAULT_TENANT_ID,
    ...(context.ownerId === undefined ? {} : { ownerId: context.ownerId }),
  };
}

/** The services of a run that live in LangGraph's `configurable` (internal). */
export interface RunServices {
  readonly run: RunContext;
  readonly executionContext?: unknown;
  /** The application's clock: a tool call's timeout runs on it (#262). */
  readonly clock?: Clock;
}

/** What a node reads of its run (internal): the run context plus the services nodes need. */
export interface NodeRunContext {
  readonly run: RunContext;
  readonly runId: RunId;
  readonly threadId: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly executionContext?: unknown;
  /** The application's clock; the system's for a graph run without one (a slice, a bare graph). */
  readonly clock: Clock;
}

const isRunContext = (value: unknown): value is RunContext =>
  typeof value === "object" && value !== null && "runId" in value && "signal" in value;

/**
 * The run of a node (internal): the `RunContext` the app put into `configurable.run`; a graph run
 * without one (a slice, a bare graph in a test) gets a context of `fallbackRunId`.
 */
export function extractRunContext(
  config: RunnableConfig | undefined,
  fallbackRunId: string,
): NodeRunContext {
  const conf: Record<string, unknown> = config?.configurable ?? {};
  const run = isRunContext(conf.run)
    ? conf.run
    : newRunContext({ runId: fallbackRunId, signal: config?.signal });
  return {
    run,
    runId: run.runId,
    threadId: run.threadId,
    metadata: run.metadata,
    executionContext: conf.executionContext,
    clock: conf.clock instanceof Clock ? conf.clock : systemClock,
  };
}

/** A cancelled run stops before its next model or tool call. */
export function throwIfCancelled(run: RunContext): void {
  if (run.signal.aborted) throw new WorkflowCancelledError("the run was cancelled");
}
