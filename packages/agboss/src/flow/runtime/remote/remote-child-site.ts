import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { RunContext } from "../../../core/run-context.js";
import type { GraphDeps } from "../../../graph/deps.js";
import { ChildPlacement } from "../../child-placement.js";
import { rootFactsOf, type Frame } from "../../context/frame.js";
import type { EndedChild } from "../child-exit.js";
import type { ChildEntered } from "../child-identity.js";
import type { RuntimeNode } from "../graph-model.js";
import { parentRecordOf, type ChildInitialState } from "./remote-child-run.js";
import type { RemoteChildSite } from "./remote-child.js";

/** What a child on any instance is queued with (#333 PR 2); `undefined` for one on this instance. */
export interface RemoteEntry {
  readonly frame: Frame;
  readonly entered: ChildEntered;
  readonly run: RunContext;
  readonly initial: ChildInitialState;
  readonly ended: EndedChild;
  readonly isRecursive: boolean;
  readonly checkpointer: BaseCheckpointSaver | undefined;
}

/**
 * The queue site of a child launched with `placement: ChildPlacement.AnyInstance`, when it can run
 * elsewhere: its own thread (ADR-0022), a shared checkpointer and the instance's queue.
 */
export function remoteSiteOf(
  node: RuntimeNode,
  deps: GraphDeps<string>,
  entry: RemoteEntry,
): RemoteChildSite | undefined {
  const { frame, entered, run, initial, ended, isRecursive, checkpointer } = entry;
  const { thread } = entered;
  const children = deps.remoteChildren;
  if (node.placement !== ChildPlacement.AnyInstance) return undefined;
  if (children === undefined || checkpointer === undefined || thread === undefined)
    return undefined;
  const { identity } = entered;
  return {
    children,
    checkpointer,
    tenantId: frame.execution.tenant.tenantId,
    executionId: identity.executionId,
    rootExecutionId: identity.rootExecutionId,
    parentExecutionId: identity.parentExecutionId,
    rootWorkflow: rootFactsOf(frame.execution).workflow.name,
    workflow: ended.workflow.name,
    depth: ended.depth,
    node: node.id,
    isRecursive,
    run: {
      thread,
      threadId: run.threadId,
      ownerId: run.ownerId,
      input: run.input,
      initial,
      parent: parentRecordOf({ execution: frame.execution, step: frame.step }),
    },
    signal: run.signal,
  };
}
