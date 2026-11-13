import type { CloseOrphanTree } from "../app/orphan-tree.js";
import {
  ExecutionRecordStatus,
  type ExecutionRecordRepository,
} from "./execution-record.repository.js";
import type { PausedExecutionRepository } from "./paused-execution.repository.js";

/**
 * The orphan look of the recovery sweep (#939, #910 I13): a tree that ended while one of its pauses
 * stayed open — its instance died between the end's writes — is found through the open pauses, a
 * page per sweep, and its end finished under its lease. Every open pause is visited at least once
 * per `ceil(open / PAGE)` sweeps: the cursor is this instance's, and wraps after the last page.
 */

/** How many open pauses one look reads. */
export const ORPHAN_PAGE = 50;

/** What the look reads and closes. */
export interface OrphanSources {
  readonly pauses: Pick<PausedExecutionRepository, "findOpenAfter">;
  /** The roots' records: the one a tree's root wrote tells whether it ended. */
  readonly records: Pick<ExecutionRecordRepository, "findByTenantIdAndRunId">;
  /** Each workflow's ending of an orphaned tree, by the bundle its records name. */
  readonly orphans: ReadonlyMap<string, CloseOrphanTree>;
  /** Where a tree whose end failed is told (it is looked at again at its next visit). */
  readonly report: (text: string) => void;
}

const ENDED: readonly string[] = [
  ExecutionRecordStatus.Answered,
  ExecutionRecordStatus.Failed,
  ExecutionRecordStatus.Guarded,
];
const isEnded = (status: string): boolean => ENDED.includes(status);

/** One instance's look: its cursor, and one page of open pauses per call. */
export class OrphanLook {
  #cursor: string | undefined;

  constructor(private readonly sources: OrphanSources) {}

  /** One look; a store that fails is reported, and asked again at the next look. */
  async lookSafely(isStopped: () => boolean): Promise<void> {
    try {
      await this.look(isStopped);
    } catch (error) {
      this.sources.report(`recovery could not look for orphaned pauses: ${String(error)}`);
    }
  }

  /** Reads one page of open pauses and finishes the end of every ended tree among them. */
  async look(isStopped: () => boolean): Promise<void> {
    const { pauses, records, orphans, report } = this.sources;
    const page = await pauses.findOpenAfter(this.#cursor, ORPHAN_PAGE);
    this.#cursor = page.next;
    const roots = new Map(
      page.pauses.map((pause) => [`${pause.tenantId}\0${pause.rootExecutionId}`, pause]),
    );
    for (const { tenantId, rootExecutionId } of roots.values()) {
      if (isStopped()) return;
      try {
        // a root with no record (another application's tree on a shared store) is skipped
        const record = await records.findByTenantIdAndRunId(tenantId, rootExecutionId);
        if (record === undefined || !isEnded(record.status)) continue;
        await orphans.get(record.bundle)?.(record);
      } catch (error) {
        report(`the end of execution ${rootExecutionId} could not be finished: ${String(error)}`);
      }
    }
  }
}

/** The look of an instance that can end orphaned trees (`undefined` without the workflows' endings). */
export function orphanLookOf(
  sources: Omit<OrphanSources, "orphans" | "report"> & {
    readonly orphans?: OrphanSources["orphans"] | undefined;
  },
  report: OrphanSources["report"],
): OrphanLook | undefined {
  const { orphans } = sources;
  return orphans === undefined ? undefined : new OrphanLook({ ...sources, orphans, report });
}
