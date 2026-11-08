import { CostSource, ZERO_USAGE, type UsageRecord } from "./usage.js";

/**
 * Lost passes of a step (#853): a model call sent by a pass that died before its answer leaves no
 * trace in the ledger. The recovery that runs the step again knows its previous holders did not
 * finish it — the tree's lease log has a takeover from each, at the checkpoint the step is pending
 * at, and the checkpoint has no write of the step's task — and records one entry per lost pass:
 * cost source `Unknown`, no amount, under an id derived from (execution, step, pass), so whoever
 * records it, and however often, the ledger adds it once. Nothing is written on a pass that took no
 * tree over.
 */

/** The `configurable` key a pass that took a tree over carries its lost passes under. */
export const LOST_PASSES_KEY = "agbossLostPasses";

/** The passes a tree's previous holders lost at its head checkpoint, as a recovery found them. */
export interface LostPasses {
  /** The tree's root execution: whose steps they are. */
  readonly rootExecutionId: string;
  /** The checkpoint every lost pass held the tree at: the steps pending there are the lost ones. */
  readonly checkpointId: string;
  /** The lease token of each lost pass, oldest first: a pass's identity in the tree. */
  readonly tokens: readonly number[];
  /** The tasks a lost pass finished at the checkpoint (a write of theirs there): not lost. */
  readonly settledTaskIds: readonly string[];
}

/** A takeover row of the lease log, as far as lost passes read it. */
export interface TakeoverRow {
  readonly kind: string;
  readonly checkpointId?: string | undefined;
  readonly previousToken?: number | undefined;
}

/**
 * The passes lost at `checkpointId`: the holder of every takeover taken at that checkpoint from a
 * lease that expired (the store named its token) — each held the tree with its steps pending there
 * and lost it before one wrote. A pass that took the tree over there and died before it ran a step
 * is one too: what it sent is not known. `undefined` when there is none.
 */
export function lostPassesOf(
  rootExecutionId: string,
  checkpointId: string | undefined,
  rows: readonly TakeoverRow[],
  settledTaskIds: readonly string[],
): LostPasses | undefined {
  if (checkpointId === undefined) return undefined;
  const tokens = new Set<number>();
  for (const row of rows)
    if (
      row.kind === "takeover" &&
      row.checkpointId === checkpointId &&
      row.previousToken !== undefined
    )
      tokens.add(row.previousToken);
  if (tokens.size === 0) return undefined;
  const sorted = [...tokens].sort((left, right) => left - right);
  return {
    rootExecutionId,
    checkpointId,
    tokens: sorted,
    settledTaskIds: [...new Set(settledTaskIds)],
  };
}

/** What a task of a graph's superstep knows of itself: its id and the checkpoint it runs from. */
export interface TaskConfig {
  readonly configurable?: Readonly<Record<string, unknown>> | undefined;
}

/** Whether `value` is lost passes as a recovery hands them on — anything else is none. */
const isLostPasses = (value: unknown): value is LostPasses => {
  if (typeof value !== "object" || value === null) return false;
  const tokens: unknown = Reflect.get(value, "tokens");
  return (
    typeof Reflect.get(value, "rootExecutionId") === "string" &&
    typeof Reflect.get(value, "checkpointId") === "string" &&
    Array.isArray(tokens) &&
    tokens.every((token) => Number.isInteger(token)) &&
    Array.isArray(Reflect.get(value, "settledTaskIds"))
  );
};

/**
 * The lost passes of the task `config` runs, if any: the pass carries lost passes, the task is of
 * the tree's root graph (`checkpoint_ns` of its graph is the root's), it runs from the checkpoint
 * they were lost at, and it has no write there. `[]` otherwise — every task of a pass that took no
 * tree over, and every task after the pass's first superstep.
 */
export function lostTokensOfTask(config: TaskConfig | undefined): {
  readonly taskId: string;
  readonly lost: LostPasses | undefined;
} {
  const configurable = config?.configurable ?? {};
  const lost: unknown = configurable[LOST_PASSES_KEY];
  const taskId = configurable.__pregel_task_id;
  const map: unknown = configurable.checkpoint_map;
  if (!isLostPasses(lost) || typeof taskId !== "string" || typeof map !== "object" || map === null)
    return { taskId: "", lost: undefined };
  // the root graph's own superstep: its tasks run from the root's checkpoint (namespace "")
  const from: unknown = Reflect.get(map, "");
  const isRootTask = Object.keys(map).length === 1 && from === lost.checkpointId;
  return isRootTask && !lost.settledTaskIds.includes(taskId)
    ? { taskId, lost }
    : { taskId, lost: undefined };
}

/** The ledger id of a lost pass of a step (#853): its execution, its step and its pass. */
export const unknownLedgerIdOf = (
  rootExecutionId: string,
  nodeId: string,
  taskId: string,
  token: number,
): string => `unknown:${rootExecutionId}:${nodeId}:${taskId}:${String(token)}`;

/**
 * One record per lost pass of the step `nodeId` (task `taskId`): of unknown cost, no amount, under
 * the lost pass's identity in the ledger — the same on every pass that records it.
 */
export const unknownCostRecordsOf = (
  lost: LostPasses,
  step: { readonly nodeId: string; readonly taskId: string; readonly caller: string },
  now: Date,
): readonly UsageRecord[] =>
  lost.tokens.map((token): UsageRecord => ({
    ...ZERO_USAGE,
    caller: step.caller,
    model: "unknown",
    costUsd: 0,
    costSource: CostSource.Unknown,
    ledgerKey: {
      id: unknownLedgerIdOf(lost.rootExecutionId, step.nodeId, step.taskId, token),
      madeAt: now,
    },
  }));
