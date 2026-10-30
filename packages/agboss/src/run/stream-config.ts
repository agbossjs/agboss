import type { Serialized } from "@langchain/core/load/serializable";
import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { newRunContext, type RunContext } from "../core/run-context.js";
import { runConfig } from "./paused.js";
import type { AgentExecutionDeps, AgentExecutionOptions, ExecutionStreamEvent } from "./types.js";

class StreamingCallbackHandler extends BaseCallbackHandler {
  name = "StreamingCallbackHandler";
  constructor(private readonly onStream: (event: ExecutionStreamEvent) => void) {
    super();
  }
  override handleLLMNewToken(token: string) {
    this.onStream({ kind: "textDelta", delta: token });
  }
  override handleToolStart(tool: Serialized, input: string) {
    this.onStream({ kind: "toolCall", tool: tool.id.at(-1) ?? "unknown", args: input });
  }
}

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
  { lease, pii }: Pick<AgentExecutionDeps<string>, "lease" | "pii">,
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
});

/** What the internal `run.input` holds: the start's input when it is an object (not a list). */
function objectInput(input: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? Object.fromEntries(Object.entries(input))
    : undefined;
}

/**
 * Stream config: checkpoint thread = run id, the run's context and services, every step
 * checkpointed before the next one starts (`durability: "sync"` — what a resume after a crash
 * continues from); tracing callbacks when on, token streaming when `onStream` is given.
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
  const callbacks = deps.tracing?.callbacks(trace) ?? [];
  if (options.onStream !== undefined) {
    callbacks.push(new StreamingCallbackHandler(options.onStream));
  }
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
