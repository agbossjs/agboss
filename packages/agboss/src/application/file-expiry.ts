import type { Class } from "../components/injection.js";
import { withChildWorkflows } from "../flow/analyse/child-workflow.js";
import { NodeKind } from "../flow/ast.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import type { ComponentOptions } from "../components/component-options.js";
import { ttlMillisOf } from "../files/file-ttl.js";
import { minutes } from "../units/index.js";
import type { Clock } from "../infrastructure/clock.js";
import type { Expiry } from "../infrastructure/expiry.js";
import type { FileOwner, FileRepository } from "../infrastructure/file.repository.js";

/**
 * Per workflow with a finite `@FilePolicy.ttl` (a workflow with no policy: the built-in 24 hours):
 * the moment before which an owner must have completed for its files to be up (#1316).
 */
export function fileCutoffsOf(
  workflows: readonly Class[],
  now: Date,
  options: ComponentOptions,
): ReadonlyMap<string, Date> {
  const cutoffs = new Map<string, Date>();
  for (const workflow of withChildWorkflows(workflows)) {
    const declaration = declarationOf(workflow);
    if (declaration?.kind !== NodeKind.Workflow) continue;
    const ttl = ttlMillisOf(options.workflowFileLimits(workflow).ttl);
    if (Number.isFinite(ttl)) cutoffs.set(declaration.options.name, new Date(now.getTime() - ttl));
  }
  return cutoffs;
}

/**
 * A file whose owner has no execution or task after this was kept for one that never came to be: an
 * orphan. Beyond the lease and an admission's fetch; younger, its execution may still be starting.
 */
export const ORPHAN_AFTER = minutes(30);

/**
 * The sweep of the files (#1316): of the executions that ended, the files whose `ttl` is up — a
 * file of one that is running or paused is never removed. The retention is the policy's, so the
 * cutoff the sweep hands over is ignored: the store gets `now` and each workflow's own.
 */
export const fileExpiryOf = (sources: {
  readonly files: FileRepository;
  readonly clock: Pick<Clock, "now">;
  readonly workflows: readonly Class[];
  /** The options of the components under the selected profiles: each workflow's effective file policy. */
  readonly options: ComponentOptions;
  /** Whether an owner has an execution or an A2A task: what keeps its files from the orphan sweep. */
  readonly isLive: (owner: FileOwner) => Promise<boolean>;
}): Expiry => ({
  what: "the files of ended executions",
  remove: async () => {
    const now = sources.clock.now();
    const expired = await sources.files.deleteExpired({
      now,
      cutoffsByWorkflow: fileCutoffsOf(sources.workflows, now, sources.options),
    });
    // a file whose owner never came to be (a crashed upload, an attempt that ran no tree)
    const orphans = await sources.files.deleteOrphans({
      createdBefore: new Date(now.getTime() - ORPHAN_AFTER),
      isLive: sources.isLive,
    });
    return expired + orphans;
  },
  retention: 0,
});
