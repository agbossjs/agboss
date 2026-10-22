import type { RunnableConfig } from "@langchain/core/runnables";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
import type { BudgetMeter } from "../../../budgets/execution-budgets.js";
import { ExecutionCancelledError } from "../../../core/errors.js";
import { extractRunContext, type RunContext } from "../../../core/run-context.js";
import type { UsageRecord } from "../../../finops/usage.js";
import type { GraphDeps } from "../../../graph/deps.js";
import {
  COMPENSATION_TIMEOUT,
  CompensationFailedError,
  CompensationReason,
  type CompensationEntry,
} from "../../compensation.js";
import { rootFactsOf, type ExecutionFacts, type Frame } from "../../context/frame.js";
import type { WorkflowIdentity } from "../step-frame.js";
import { joinKeysOf } from "../workflow-keys.js";
import { entriesInCheckpoint } from "./checkpoint-entries.js";
import type { UndoSite } from "./undo.js";
import { unwound, type UnwindSite } from "./unwind.js";

/**
 * A child execution that ends without a finish undoes its own open entries before its error reaches
 * its parent (#340 Q2, PR 3): failed (`CompensationReason.ExecutionFailed`), cancelled or aborted by
 * its launch's `FailFast` (`ExecutionCancelled`). The entries are its checkpoint's (the earlier
 * passes', S3 Q-C) merged with the instance registry's (this pass's: the child's in-process last
 * state misses writes after the abort, S2); its running bodies are awaited first (Q-A), and once
 * done the child is sealed (Q-B). The undo's spend goes to the ledger at once — the parent's step
 * may never write its state. A failing undo makes the child's error `CompensationFailedError`,
 * which passes the parent's boundary as it is (S5).
 */

/** Where a child that threw undoes: the child, its parent's step, the pass. */
export interface ChildUnwindSite {
  readonly deps: GraphDeps<string>;
  readonly workflow: WorkflowIdentity;
  readonly executionId: string;
  /** The child's run (its thread, owner, place in the tree). */
  readonly run: RunContext;
  readonly parent: Frame;
  readonly config: RunnableConfig;
  readonly checkpointer?: BaseCheckpointSaver | undefined;
  readonly budgets?: BudgetMeter | undefined;
  /** The child's last state streamed in process, if any. */
  readonly last: readonly CompensationEntry[];
}

/** What the child's unwind made of its error: the error to raise, the entries it closed. */
export interface ChildUnwound {
  readonly thrown: unknown;
  readonly closed: readonly CompensationEntry[];
}

/** The child's own execution, as its undo actions' frames read it. */
function factsOf(site: ChildUnwindSite): ExecutionFacts {
  const { run, parent, workflow } = site;
  return Object.freeze({
    executionId: site.executionId,
    threadId: run.threadId,
    ownerId: run.ownerId,
    signal: run.signal,
    workflow: Object.freeze({ ...workflow, startedVersion: workflow.version }),
    tenant: parent.execution.tenant,
    values: parent.execution.values,
    ...(run.tree === undefined ? {} : { parent: run.tree.parent, itemIndex: run.tree.itemIndex }),
  });
}

/** The child's entries as its checkpoint holds them (none without a checkpointer). */
async function checkpointed(site: ChildUnwindSite, root: string) {
  if (site.checkpointer === undefined) return [];
  const found = await entriesInCheckpoint(site.checkpointer, site.config, root);
  return found.flatMap((each) => each.entries);
}

/** Undoes the child's open entries; the error its parent gets. */
export async function unwoundChild(site: ChildUnwindSite, thrown: unknown): Promise<ChildUnwound> {
  const { deps, executionId } = site;
  const rootId = rootFactsOf(site.parent.execution).executionId;
  const where = { tenantId: site.parent.execution.tenant.tenantId, rootExecutionId: rootId };
  const isCancelled = thrown instanceof ExecutionCancelledError;
  const undo: UndoSite = {
    ...{ graph: deps.graph, container: deps.container },
    components: joinKeysOf(deps).components,
    observer: deps.observer,
    execution: factsOf(site),
    clock: extractRunContext(site.config, executionId).clock,
    timeout: deps.compensation?.timeout ?? COMPENSATION_TIMEOUT,
    stepEntries: deps.stepEntries,
    reason: isCancelled
      ? CompensationReason.ExecutionCancelled
      : CompensationReason.ExecutionFailed,
  };
  const covers = (entry: CompensationEntry): boolean => entry.executionId === executionId;
  const record = async (usage: readonly UsageRecord[]): Promise<void> => {
    await site.budgets?.record(usage);
  };
  const unwind: UnwindSite = {
    tree: where,
    covers,
    runs: (entry) => entry.executionId === executionId,
    known: [...(await checkpointed(site, rootId)), ...site.last].filter(covers),
    undoSiteOf: () => undo,
    parts: deps.compensation,
    stepEntries: deps.stepEntries,
    ...{ clock: undo.clock, timeout: undo.timeout },
    isSealing: true,
    record,
  };
  const { closed, usage, failures } = await unwound(unwind);
  await record(usage);
  if (failures.length === 0) return { thrown, closed };
  return { thrown: new CompensationFailedError(failures, thrown), closed };
}
