import type { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { newRunContext, type RunContext } from "../core/run-context.js";
import type { PiiRuntime } from "../pii/runtime.js";
import { runConfig } from "./paused.js";
import { RunStream } from "./stream/run-stream.js";
import type { AgentExecutionDeps, AgentExecutionOptions } from "./types.js";

/** What a run streams with besides its options: its ids and its start's input. */
export interface RunIdentity {
  readonly threadId: string;
  /** The tenant of its thread (#261). */
  readonly tenantId: string;
  readonly runId: string;
  /** The start's validated input (the internal `run.input` when it is an object). */
  readonly input?: unknown;
}

/** The run's `RunContext`: built once here, read by every node through `configurable.run`. */
const runContextOf = (
  identity: RunIdentity,
  options: AgentExecutionOptions,
  {
    lease,
    pii,
    fingerprintKeys,
  }: Pick<AgentExecutionDeps<string>, "lease" | "pii" | "fingerprintKeys">,
): RunContext => ({
  ...newRunContext({
    lease,
    runId: identity.runId,
    threadId: identity.threadId,
    signal: options.signal,
    ownerId: options.ownerId,
    tenantId: identity.tenantId,
    input: objectInput(identity.input),
  }),
  // what its steps' outbound calls store of a request (#505)
  observability: pii?.observability,
  // what a business key's handle in an error is keyed by (#508)
  ...piiKeysOf(pii),
  // what a business key's fingerprint is keyed by (#825): the application's idempotency keys
  fingerprintKeys,
  // the caller's stream (#1004): reached only by an agent's answer and its tool calls
  ...(options.onStream === undefined ? {} : { stream: new RunStream(options.onStream) }),
});

/**
 * The key a run's steps derive from its PII key (#508): a business key's handle (the field key). A
 * fingerprint is never keyed by it (#825: the application's idempotency key, `fingerprintKeys`).
 */
export const piiKeysOf = (
  pii: Pick<PiiRuntime, "fieldKey"> | undefined,
): Pick<RunContext, "correlationKey"> => ({ correlationKey: pii?.fieldKey });

/** What the internal `run.input` holds: the start's input when it is an object (not a list). */
function objectInput(input: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? Object.fromEntries(Object.entries(input))
    : undefined;
}

/**
 * Stream config: checkpoint thread = run id, the run's context and services, every step
 * checkpointed before the next one starts (`durability: "sync"` — what a resume after a crash
 * continues from); tracing callbacks when on, the run's stream sink when `onStream` is given.
 */
export function streamConfig<TName extends string>(
  deps: AgentExecutionDeps<TName>,
  identity: RunIdentity,
  options: AgentExecutionOptions = {},
): ReturnType<typeof runConfig> & {
  streamMode: "values";
  durability: "sync";
  runName: string;
  metadata: Readonly<Record<string, string>>;
  tags: string[];
  callbacks: BaseCallbackHandler[];
  signal?: AbortSignal;
} {
  const { threadId, runId, tenantId } = identity;
  const trace = { bundle: deps.config.name, threadId, runId, tenantId };
  // tracing only: the stream is no callback of the run (#1004), so no internal model call hears it
  const callbacks = deps.tracing?.callbacks(trace) ?? [];
  const run = runContextOf(identity, options, deps);
  const services = {
    run,
    ...(deps.clock === undefined ? {} : { clock: deps.clock }),
  };
  return {
    // the checkpoint thread is the run; its rows are tagged with the run's tenant (#261 AC6)
    ...runConfig(runId, services, { ...options.configurable, tenant_id: tenantId }),
    streamMode: "values",
    durability: "sync",
    runName: deps.config.name,
    // the standard LangGraph fields (#261 AC6): a trace or checkpoint is found by its organization
    metadata: {
      tenantId,
      executionId: runId,
      rootExecutionId: runId,
      threadId,
      workflowName: deps.config.name,
      workflowVersion: deps.config.version,
    },
    tags: [`tenant:${tenantId}`, deps.config.name],
    callbacks,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
}
