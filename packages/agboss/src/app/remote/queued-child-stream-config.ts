import type { RunContext } from "../../core/run-context.js";
import type { RemoteChildRun } from "../../flow/runtime/remote/remote-child-run.js";
import type { GraphDeps } from "../../graph/deps.js";
import { ROOT_EXECUTION_ID_KEY } from "../../infrastructure/checkpoint-threads.js";
import { streamConfig } from "../../run/stream-config.js";
import { queuedChildMetadataOf } from "../../tracing/workflow-chain.js";
import type { AppDeps } from "../app-deps.js";

/** Builds the LangGraph config for the child's own thread. */
export function childStreamConfig(
  childDeps: GraphDeps<string>,
  rootDeps: AppDeps,
  run: RemoteChildRun,
  context: RunContext,
): ReturnType<typeof streamConfig> {
  const { initial } = run;
  const identity = {
    threadId: context.threadId,
    tenantId: context.tenantId,
    runId: context.runId,
    input: context.input,
  };
  const base = streamConfig(rootDeps, identity, { signal: context.signal });
  return {
    ...base,
    runName: childDeps.config.name,
    configurable: {
      ...base.configurable,
      run: context,
      thread_id: run.thread,
      // its checkpoints belong to the root's tree (#1321d), not to a tree of its own id
      [ROOT_EXECUTION_ID_KEY]: initial.child.rootExecutionId,
    },
    metadata: {
      ...base.metadata,
      executionId: context.runId,
      parentExecutionId: initial.child.parentExecutionId,
      rootExecutionId: initial.child.rootExecutionId,
      // its spans are the child's, masked by its chain's policies (#1150), never the root's alone
      ...queuedChildMetadataOf(childDeps.config, run.parent),
    },
  };
}
