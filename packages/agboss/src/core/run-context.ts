import type { RunnableConfig } from "@langchain/core/runnables";
import { ExecutionCancelledError } from "./errors.js";
import { DEFAULT_TENANT_ID } from "../flow/context/tenant-context.js";
import { Clock, systemClock } from "../infrastructure/clock.js";
import type { FrameLease, ParentExecution } from "../flow/context/frame.js";
import type { ObservabilityMask } from "../pii/observability-mask.js";

/** The id of one run (one `execute`, kept by its resumes) — not the conversation thread. */
export type ExecutionId = string & { readonly __brand: "ExecutionId" };

/** Marks a string as a run id (the framework's own ids; tests building a context). */
export const runIdOf = (id: string): ExecutionId => id as ExecutionId;

/**
 * The run as the framework's own code knows it (internal; projects read `ExecutionContext`, #280):
 * built once per `execute` / `resume` and the same for every node of the run.
 */
export interface RunContext {
  /** Unique per run; the same after a resume. */
  readonly runId: ExecutionId;
  /** The conversation the run belongs to (`ExecutionOutput.thread`). */
  readonly threadId: string;
  /** Aborted by `app.cancel(thread)` or by the caller's own `signal`. */
  readonly signal: AbortSignal;
  /** Who the thread belongs to (`execute(…, { ownerId })`); only that owner may continue it. */
  readonly ownerId?: string;
  /** The tenant the run works for (#261): `"default"` when it names none. */
  readonly tenantId: string;
  /** The validated input of the workflow start the run began at (`{}` when unknown); kept by its resumes. */
  readonly input: Readonly<Record<string, unknown>>;
  /** A child execution's place in its tree (#263): its parent and its item; absent at the root. */
  readonly tree?: ExecutionTreePlace;
  /** The lease the run's steps run under (#471); absent outside a pass. */
  readonly lease?: FrameLease | undefined;
  /** The workflow's observability mask (#505): what its steps' outbound calls store of a request. */
  readonly observability?: ObservabilityMask | undefined;
  /**
   * The application's PII field key (#508): what a business key's handle in an error is keyed by,
   * unless the execution has a key of its own (#334).
   */
  readonly correlationKey?: string | undefined;
  /** The application's own PII key, when it sets one (#508): what a fingerprint is keyed by. */
  readonly fingerprintKey?: string | undefined;
}

/** Where a child execution stands (#263): the execution and step that launched it, its item. */
export interface ExecutionTreePlace {
  readonly parent: ParentExecution;
  readonly itemIndex?: number | undefined;
}

/** A run context with defaults: its own thread, the default tenant, a signal nobody aborts, no input. */
export function newRunContext(context: {
  readonly runId: string;
  readonly threadId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly ownerId?: string | undefined;
  readonly tenantId?: string | undefined;
  readonly input?: Readonly<Record<string, unknown>> | undefined;
  readonly lease?: FrameLease | undefined;
}): RunContext {
  return {
    runId: runIdOf(context.runId),
    threadId: context.threadId ?? context.runId,
    signal: context.signal ?? new AbortController().signal,
    input: context.input ?? {},
    tenantId: context.tenantId ?? DEFAULT_TENANT_ID,
    ...(context.ownerId === undefined ? {} : { ownerId: context.ownerId }),
    ...(context.lease === undefined ? {} : { lease: context.lease }),
  };
}

/** The services of a run that live in LangGraph's `configurable` (internal). */
export interface RunServices {
  readonly run: RunContext;
  /** The application's clock: a tool call's timeout runs on it (#262). */
  readonly clock?: Clock;
}

/** What a node reads of its run (internal): the run context plus the services nodes need. */
export interface NodeRunContext {
  readonly run: RunContext;
  readonly runId: ExecutionId;
  readonly threadId: string;
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
    clock: conf.clock instanceof Clock ? conf.clock : systemClock,
  };
}

/** A cancelled run stops before its next model or tool call. */
export function throwIfCancelled(run: RunContext): void {
  if (run.signal.aborted) throw new ExecutionCancelledError("the run was cancelled");
}
