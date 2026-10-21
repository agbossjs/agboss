import { AGBossError } from "../core/errors.js";
import type { HistoryTurn, ReaderMemory } from "../flow/runtime/history.js";
import type { Summary, Tern, TernRecords, TernStore } from "../terns/index.js";
import { TurnLimit, type UncompactedTurns } from "../compaction/compaction.decorator.js";
import { memoryPlanOf, readerOf, type MemoryPlan, type MemoryReader } from "../compaction/plan.js";
import { NodeKind } from "../flow/ast.js";
import type { RunDeps } from "./types.js";

/** At most this long: a thread id is a key, not data. */
const MAX_THREAD_ID_LENGTH = 200;

/** A control character (U+0000–U+001F, U+007F): never in a thread id. */
const isControl = (code: number): boolean => code < 0x20 || code === 0x7f;

/** A thread id a caller may pick (#262 Q4): 1 to 200 characters, no control characters. */
function isThreadId(threadId: string): boolean {
  if (threadId.length === 0 || threadId.length > MAX_THREAD_ID_LENGTH) return false;
  for (let index = 0; index < threadId.length; index += 1) {
    if (isControl(threadId.charCodeAt(index))) return false;
  }
  return true;
}

export class UnknownThreadError extends AGBossError {
  static override readonly code: string = "run.unknown-thread";
  override name = "UnknownThreadError";
}

/** A thread used by a caller that is not its owner (`execute`, `resume`, `cancel` with `ownerId`). */
export class ThreadOwnerError extends AGBossError {
  static override readonly code: string = "run.thread-owner";
  override name = "ThreadOwnerError";
}

/** A thread id a caller picked that cannot be one: empty, over 200 characters, a control character. */
export class InvalidThreadIdError extends AGBossError {
  static override readonly code: string = "run.invalid-thread-id";
  override name = "InvalidThreadIdError";
}

const notTheOwner = (threadId: string): ThreadOwnerError =>
  new ThreadOwnerError(`Thread "${threadId}" belongs to another owner`, {
    details: { thread: threadId },
  });

/**
 * A thread as a caller names it (#261): its key is the tenant and the thread id — the same id in
 * two tenants is two threads — and `ownerId` the access key inside the tenant.
 */
export interface ThreadAccess {
  readonly tenantId: string;
  readonly threadId: string;
  readonly ownerId: string | undefined;
}

/** A thread `execute` creates: the caller's own id, or none — then one is made. */
export interface NewThreadAccess extends Omit<ThreadAccess, "threadId"> {
  readonly threadId: string | undefined;
}

/**
 * A thread is used only by the owner it was created for (`ExecutionOptions.ownerId`): a different
 * owner, or none for an owned thread (and the other way round), fails before anything runs. The
 * message names neither owner. A thread the store does not know is left to the caller's own check.
 */
export async function checkThreadOwner(
  terns: Pick<TernStore, "threadOwner">,
  bundle: string,
  access: ThreadAccess,
): Promise<void> {
  const thread = await terns.threadOwner(bundle, access.tenantId, access.threadId);
  if (thread === undefined || thread.owner === access.ownerId) return;
  throw notTheOwner(access.threadId);
}

/**
 * `execute` with a thread id (#262 Q4): an id the tenant has must belong to the caller's owner; an
 * id it does not have yet is the caller's own new thread — `true`, created once the budgets pass
 * (a refused execution creates nothing). An id that cannot be one is `InvalidThreadIdError`.
 */
export async function isNewThread(
  terns: Pick<TernStore, "threadOwner">,
  bundle: string,
  access: ThreadAccess,
): Promise<boolean> {
  if (!isThreadId(access.threadId)) {
    const why = `1 to ${String(MAX_THREAD_ID_LENGTH)} characters, no control characters`;
    throw new InvalidThreadIdError(`Not a thread id: ${why}`);
  }
  const thread = await terns.threadOwner(bundle, access.tenantId, access.threadId);
  if (thread === undefined) return true;
  if (thread.owner !== access.ownerId) throw notTheOwner(access.threadId);
  return false;
}

/** No such thread in the tenant — with no hint whether another tenant has the id. */
const unknownThread = (bundle: string, threadId: string): UnknownThreadError =>
  new UnknownThreadError(`Unknown thread "${threadId}" for "${bundle}"`);

/**
 * `execute` or `cancel` on a given thread: it must exist in the caller's tenant for this workflow —
 * another tenant's thread does not exist for it — and belong to the caller's owner.
 */
export async function checkThreadAccess(
  terns: Pick<TernStore, "threadOwner">,
  bundle: string,
  access: ThreadAccess,
): Promise<void> {
  const thread = await terns.threadOwner(bundle, access.tenantId, access.threadId);
  if (thread === undefined) throw unknownThread(bundle, access.threadId);
  if (thread.owner !== access.ownerId) throw notTheOwner(access.threadId);
}

/** The thread's turns (S8): only finished executions, each as its start and finish line. */
export const toTurns = (terns: readonly Tern[]): HistoryTurn[] =>
  terns
    .filter((tern) => tern.status === "answered" && tern.replyWith !== "")
    .map(({ task, replyWith }) => ({ start: task, finish: replyWith }));

/** A window as a count of records: `TurnLimit.ALL` is every one. */
const depthOf = (window: UncompactedTurns): number =>
  window === TurnLimit.ALL ? Number.MAX_SAFE_INTEGER : window;

/** What one compaction holds of the thread: its records not yet summarised, its latest summaries. */
interface CompactionState {
  readonly uncovered: readonly Tern[];
  readonly summaries: readonly Summary[];
}

async function compactionStatesOf(
  terns: TernRecords,
  thread: Pick<ThreadAccess, "tenantId" | "threadId">,
  plan: MemoryPlan,
): Promise<ReadonlyMap<string, CompactionState>> {
  const { tenantId, threadId } = thread;
  const states = await Promise.all(
    plan.compactions.map(async (compaction): Promise<[string, CompactionState]> => [
      compaction.name,
      {
        uncovered: await terns.uncovered(tenantId, threadId, compaction.name),
        summaries: await terns.latestSummaries(
          tenantId,
          threadId,
          compaction.name,
          compaction.summaryQueueLength,
        ),
      },
    ]),
  );
  return new Map(states);
}

/**
 * How many of the thread's last records a reader sees in full: its window — and, with a compaction
 * that writes summaries, at least every record that compaction has not summarised yet, so no turn
 * is lost between two compactions.
 */
const rawDepthOf = (reader: MemoryReader, state: CompactionState | undefined): number =>
  Math.max(depthOf(reader.window), state?.uncovered.length ?? 0);

/** One reader's memory over the loaded records: its turns, and the summaries they do not cover. */
function readerMemory(
  records: readonly Tern[],
  depth: number,
  state: CompactionState | undefined,
): ReaderMemory {
  const raw = depth === 0 ? [] : records.slice(-depth);
  const seen = new Set(raw.map((tern) => tern.id));
  const summaries = (state?.summaries ?? [])
    .filter((summary) => !seen.has(summary.fromTernId))
    .map((summary) => summary.text);
  return { turns: toTurns(raw).length, summaries };
}

/** Every reader of the graph: the plan's, and any router it does not list (the workflow's window). */
function readersOf<TName extends string>(
  deps: RunDeps<TName>,
  plan: MemoryPlan,
): readonly (readonly [string, MemoryReader])[] {
  const routers = [...deps.graph.nodes.values()].flatMap((node) =>
    node.kind === NodeKind.Router && !plan.readers.has(node.id) ? [node.id] : [],
  );
  return [...plan.readers, ...routers.map((name) => [name, readerOf(plan, name)] as const)];
}

/**
 * The thread's memory for an execution (#120 PR 3): its last turns, as deep as the deepest reader
 * needs, and what each agent and model router remembers of them — its window over the turns and
 * its compaction's latest summaries (`summaryQueueLength`, one for a single summary).
 */
async function memoryOf<TName extends string>(
  deps: RunDeps<TName>,
  thread: Pick<ThreadAccess, "tenantId" | "threadId">,
): Promise<ThreadMemory> {
  const plan = memoryPlanOf(deps.config, deps.compactions);
  const states = await compactionStatesOf(deps.terns, thread, plan);
  const readers = readersOf(deps, plan);
  const depths = new Map(
    readers.map(([name, reader]) => [
      name,
      rawDepthOf(reader, states.get(reader.compaction?.name ?? "")),
    ]),
  );
  const deepest = Math.max(0, depthOf(plan.fallback.window), ...depths.values());
  const records =
    deepest === 0 ? [] : await deps.terns.lastTerns(thread.tenantId, thread.threadId, deepest);
  const memory = Object.fromEntries(
    readers.map(([name, reader]) => [
      name,
      readerMemory(records, depths.get(name) ?? 0, states.get(reader.compaction?.name ?? "")),
    ]),
  );
  return { history: toTurns(records), memory };
}

/** What an execution loads of its thread: the turns and each reader's memory of them. */
export interface ThreadMemory {
  readonly history: HistoryTurn[];
  readonly memory: Record<string, ReaderMemory>;
}

/** First contact → a new thread; a given id must exist in the tenant for this workflow (no calls). */
export async function openThread<TName extends string>(
  deps: RunDeps<TName>,
  tenantId: string,
  requested: string | undefined,
): Promise<{ readonly threadId: string } & ThreadMemory> {
  const bundle = deps.config.name;
  if (requested === undefined) {
    const threadId = await deps.terns.createThread({ workflow: bundle, tenantId });
    return { threadId, history: [], memory: {} };
  }
  if (!(await deps.terns.hasThread(bundle, tenantId, requested))) {
    throw unknownThread(bundle, requested);
  }
  return { threadId: requested, ...(await memoryOf(deps, { tenantId, threadId: requested })) };
}
