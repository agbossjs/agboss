import type { Class } from "../components/injection.js";
import { withChildWorkflows } from "../flow/analyse/child-workflow.js";
import { NodeKind } from "../flow/ast.js";
import { declarationOf } from "../flow/decorators/declaration.js";
import { fileLimitsOf } from "../files/file-policy.js";
import { ttlMillisOf } from "../files/file-ttl.js";
import { workflowFilePolicyOf } from "../files/workflow-file-policy.js";
import type { Clock } from "../infrastructure/clock.js";
import type { Expiry } from "../infrastructure/expiry.js";
import type { FileRepository } from "../infrastructure/file.repository.js";

/**
 * Per workflow with a finite `@FilePolicy.ttl` (a workflow with no policy: the built-in 24 hours):
 * the moment before which an owner must have completed for its files to be up (#1316).
 */
export function fileCutoffsOf(workflows: readonly Class[], now: Date): ReadonlyMap<string, Date> {
  const cutoffs = new Map<string, Date>();
  for (const workflow of withChildWorkflows(workflows)) {
    const declaration = declarationOf(workflow);
    if (declaration?.kind !== NodeKind.Workflow) continue;
    const ttl = ttlMillisOf(fileLimitsOf(workflowFilePolicyOf(workflow)).ttl);
    if (Number.isFinite(ttl)) cutoffs.set(declaration.options.name, new Date(now.getTime() - ttl));
  }
  return cutoffs;
}

/**
 * The sweep of the files (#1316): of the executions that ended, the files whose `ttl` is up — a
 * file of one that is running or paused is never removed. The retention is the policy's, so the
 * cutoff the sweep hands over is ignored: the store gets `now` and each workflow's own.
 */
export const fileExpiryOf = (sources: {
  readonly files: FileRepository;
  readonly clock: Pick<Clock, "now">;
  readonly workflows: readonly Class[];
}): Expiry => ({
  what: "the files of ended executions",
  remove: () => {
    const now = sources.clock.now();
    return sources.files.deleteExpired({
      now,
      cutoffsByWorkflow: fileCutoffsOf(sources.workflows, now),
    });
  },
  retention: 0,
});
