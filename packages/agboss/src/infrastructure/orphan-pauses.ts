import type { WakeAnswered, WakeParked } from "../app/answered-wake.js";
import type { CloseOrphanTree } from "../app/orphan-tree.js";
import {
  ExecutionRecordStatus,
  type ExecutionRecordRepository,
} from "./execution-record.repository.js";
import type { PausedExecutionRepository } from "./paused-execution.repository.js";
import { PauseStatus } from "./pause-record.js";

/**
 * The orphan look of the recovery sweep (#939, #910 I13): a tree that ended while one of its pauses
 * stayed open — its instance died between the end's writes — is found through the open pauses, a
 * page per sweep, and its end finished under its lease. Every open pause is visited at least once
 * per `ceil(open / PAGE)` sweeps: the cursor is this instance's, and wraps after the last page.
 * The same look wakes a root left `paused` beside an answer no pass took (#1187, `answered-wake.ts`):
 * its record marked `running` under its lease, recovery's to continue.
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
  /** Each workflow's wake of a `paused` root beside an untaken answer (#1187), by bundle. */
  readonly wakes?: ReadonlyMap<string, WakeAnswered> | undefined;
  /**
   * The wake of a `paused` root an `app.unpause` died on (#1341c): each workflow's by bundle, and the
   * records it pages through by status (a parked tree has no open pause for the look to find).
   */
  readonly parked?:
    | {
        readonly wakes: ReadonlyMap<string, WakeParked>;
        readonly list: Pick<ExecutionRecordRepository, "findByStatus">;
      }
    | undefined;
  /** Where a tree whose end failed is told (it is looked at again at its next visit). */
  readonly report: (text: string) => void;
}

const ENDED: readonly string[] = [
  ExecutionRecordStatus.Answered,
  ExecutionRecordStatus.Failed,
  ExecutionRecordStatus.Guarded,
  ExecutionRecordStatus.Stopped,
  ExecutionRecordStatus.Cancelled,
];
const isEnded = (status: string): boolean => ENDED.includes(status);
const RESTING: string = ExecutionRecordStatus.Paused;

/** A pause's root: what the look reads its record by. */
interface PauseRoot {
  readonly tenantId: string;
  readonly rootExecutionId: string;
}

const rootKeyOf = (root: PauseRoot): string => `${root.tenantId}\0${root.rootExecutionId}`;

/** One instance's look: its cursor, and one page of open pauses per call. */
export class OrphanLook {
  #cursor: string | undefined;
  /** Where the look at the `paused` records stopped (#1341c): the record's id, wrapping after the last page. */
  #parkedCursor: string | undefined;

  constructor(private readonly sources: OrphanSources) {}

  /** One look; a store that fails is reported, and asked again at the next look. */
  async lookSafely(isStopped: () => boolean): Promise<void> {
    try {
      await this.look(isStopped);
    } catch (error) {
      this.sources.report(`recovery could not look for orphaned pauses: ${String(error)}`);
    }
  }

  /** `lookParked`; a store that fails is reported, and asked again at the next look. */
  async lookParkedSafely(isStopped: () => boolean): Promise<void> {
    try {
      await this.lookParked(isStopped);
    } catch (error) {
      this.sources.report(`recovery could not look for parked executions: ${String(error)}`);
    }
  }

  /**
   * Reads one page of open pauses: finishes the end of every ended tree among them and of every
   * resting one whose cancel nobody finished (#1152), and wakes every other `paused` root beside an
   * answer recorded and not taken yet (#1187).
   */
  async look(isStopped: () => boolean): Promise<void> {
    const page = await this.sources.pauses.findOpenAfter(this.#cursor, ORPHAN_PAGE);
    this.#cursor = page.next;
    const roots = new Map(page.pauses.map((pause) => [rootKeyOf(pause), pause]));
    const answered = new Set(
      page.pauses.filter((pause) => pause.status === PauseStatus.Resolved).map(rootKeyOf),
    );
    for (const [key, root] of roots) {
      if (isStopped()) return;
      try {
        await this.#visit(root, answered.has(key));
      } catch (error) {
        const text = `the end of execution ${root.rootExecutionId} could not be finished`;
        this.sources.report(`${text}: ${String(error)}`);
      }
    }
  }

  /**
   * One page of the `paused` records, found by their status and not through the open pauses: a tree
   * parked by `app.pause` has none (#1341c). One an `app.unpause` died on — the freeze lifted, the
   * record still `paused` — is marked `running` (`wakeParked`), recovery's to continue in the same
   * sweep after the next. Run after the sweep's own look at the `running` records, so that no tree
   * is woken into the very sweep that read them (a resume that marks its record `running` meanwhile
   * is never recovered under it). A store that fails is reported by `lookParkedSafely`.
   */
  async lookParked(isStopped: () => boolean): Promise<void> {
    const { parked } = this.sources;
    if (parked === undefined || parked.wakes.size === 0) return;
    const page = await parked.list.findByStatus({
      status: ExecutionRecordStatus.Paused,
      limit: ORPHAN_PAGE,
      ...(this.#parkedCursor === undefined ? {} : { cursor: this.#parkedCursor }),
    });
    this.#parkedCursor = page.nextCursor;
    for (const record of page.items) {
      if (isStopped()) return;
      try {
        await parked.wakes.get(record.workflow)?.(record);
      } catch (error) {
        const text = `the parked execution ${record.runId ?? record.id} could not be woken`;
        this.sources.report(`${text}: ${String(error)}`);
      }
    }
  }

  /**
   * One root of the page: its end finished when it ended; when it rests, ended when its cancel was
   * requested, else woken beside an untaken answer.
   */
  async #visit(root: PauseRoot, isAnswered: boolean): Promise<void> {
    const { records, orphans, wakes } = this.sources;
    // a root with no record (another application's tree on a shared store) is skipped
    const record = await records.findByTenantIdAndRunId(root.tenantId, root.rootExecutionId);
    if (record === undefined) return;
    if (isEnded(record.status)) {
      await orphans.get(record.workflow)?.(record);
      return;
    }
    if (record.status !== RESTING) return;
    // a resting tree with a cancel nobody finished is ended (#1152), never woken; else an answer
    // recorded and not taken wakes it (#1187)
    const isCancelled = (await orphans.get(record.workflow)?.(record)) === true;
    if (!isCancelled && isAnswered) await wakes?.get(record.workflow)?.(record);
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
