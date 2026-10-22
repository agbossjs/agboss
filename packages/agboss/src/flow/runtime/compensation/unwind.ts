import { errorRecordOf } from "../../../core/error-record.js";
import type { UsageRecord } from "../../../finops/usage.js";
import type { Clock } from "../../../infrastructure/clock.js";
import { timeoutError, timeoutOn } from "../../../infrastructure/clock-timeout.js";
import type { ExecutionTree } from "../../../infrastructure/execution-tree.repository.js";
import type { Milliseconds } from "../../../units/index.js";
import {
  CompensationEntryStatus,
  CompensationStatus,
  type CompensationEntry,
  type CompensationRecord,
} from "../../compensation.js";
import type { StepEntries, StepEntry } from "../step-entries.js";
import type { CompensationParts } from "./registry.js";
import { undone, type UndoSite } from "./undo.js";

/**
 * An automatic unwind (#340): a failed join's (its launch's entries), a child's or a root's that
 * ends without a finish (its execution's, or its whole tree's). It first awaits the running step
 * bodies it covers, up to `compensationTimeout` (S3 Q-A) — one still running then is reported —
 * then undoes the open entries it covers, newest first: the ones it was given (the state's, the
 * checkpoint's) merged with the instance registry's, read again after every undo, so a late body
 * that returns meanwhile is undone too. Each closed entry goes to the registry at once. A sealing
 * unwind (a child's, a root's) then seals what it covers: an undoable action that succeeds after it
 * ended is undone at once, in process (Q-B), its spend written by `record`.
 */

/** What one unwind covers and where it undoes. */
export interface UnwindSite {
  readonly tree: ExecutionTree;
  /** Whether an entry is one of the unwind's (its launch's, its execution's, its tree's). */
  readonly covers: (entry: CompensationEntry) => boolean;
  /** Whether a running step body is one it waits for before undoing. */
  readonly runs: (entry: StepEntry) => boolean;
  /** The entries known besides the registry's: the state's or the checkpoint's. */
  readonly known: readonly CompensationEntry[];
  /** Where the undo of an entry runs: its execution's frame and graph. */
  readonly undoSiteOf: (entry: CompensationEntry) => UndoSite;
  readonly parts?: CompensationParts | undefined;
  readonly stepEntries?: StepEntries | undefined;
  readonly clock: Clock;
  readonly timeout: Milliseconds;
  /** Seal what it covers once it ended (a child's or a root's unwind; never a join's). */
  readonly isSealing: boolean;
  /** Where a late undo's spend goes (the ledger, at once). */
  readonly record: (usage: readonly UsageRecord[]) => Promise<void>;
  /** After each undo ended: its durable mark when it succeeded (a child's, a root's, #340 PR 4). */
  readonly onUndone?: ((entry: CompensationEntry) => Promise<void>) | undefined;
}

/** What an unwind did: the entries it closed (in the order they ended), their spend, the failures. */
export interface Unwound {
  readonly closed: readonly CompensationEntry[];
  readonly usage: readonly UsageRecord[];
  readonly failures: readonly CompensationRecord[];
}

/** Entries by key, the later one winning — except that an open one never reopens a closed one. */
export function mergedEntries(
  ...lists: readonly (readonly CompensationEntry[])[]
): readonly CompensationEntry[] {
  const merged = new Map<string, CompensationEntry>();
  for (const entry of lists.flat()) {
    const known = merged.get(entry.key);
    const reopens =
      known !== undefined &&
      known.status !== CompensationEntryStatus.Open &&
      entry.status === CompensationEntryStatus.Open;
    if (!reopens) merged.set(entry.key, entry);
  }
  return [...merged.values()];
}

/** The open entries of the unwind not undone yet, newest first. */
function openNow(site: UnwindSite, done: ReadonlySet<string>): readonly CompensationEntry[] {
  const mirrored = site.parts?.registry.entriesOf(site.tree, site.covers) ?? [];
  return mergedEntries(site.known, mirrored)
    .filter(
      (entry) =>
        site.covers(entry) && entry.status === CompensationEntryStatus.Open && !done.has(entry.key),
    )
    .sort((first, second) => second.sequence - first.sequence);
}

/** Awaits the running bodies the unwind covers, up to its bound; a body still running is reported. */
export async function bodiesSettled(site: UnwindSite): Promise<void> {
  if (site.stepEntries === undefined) return;
  const bound = timeoutOn(site.clock, site.timeout, timeoutError);
  try {
    const running = await site.stepEntries.closedWhere(site.tree, site.runs, bound.signal);
    for (const body of running) {
      const text = `the undo of execution ${body.executionId} goes on while ${body.nodeId} still runs; it is undone when it returns`;
      const subject = { executionId: body.executionId, tenantId: site.tree.tenantId };
      site.parts?.log?.warn("compensation.step-still-running", text, subject);
    }
  } finally {
    bound.release();
  }
}

/** A late undo (Q-B): run at once, its spend recorded; a failure is reported, there is no one to fail. */
async function lateUndo(site: UnwindSite, entry: CompensationEntry): Promise<void> {
  const subject = { executionId: entry.executionId, tenantId: site.tree.tenantId };
  try {
    const ran = await undone(entry, site.undoSiteOf(entry));
    await site.record(ran.usage);
    const error = ran.entry.undo?.error;
    if (error !== undefined) {
      const text = `the late undo of ${entry.action} by ${entry.compensator} failed: ${error.message}`;
      site.parts?.log?.warn("compensation.late-undo-failed", text, subject);
    }
  } catch (thrown) {
    const text = `the late undo of ${entry.action} did not run: ${errorRecordOf(thrown).message}`;
    site.parts?.log?.warn("compensation.late-undo-failed", text, subject);
  }
}

/** Seals what the unwind covers until its executions' last running body returned. */
function seal(site: UnwindSite): void {
  const { parts, stepEntries } = site;
  if (!site.isSealing || parts === undefined || stepEntries === undefined) return;
  const lift = parts.registry.seal(site.tree, site.covers, (entry) => {
    void lateUndo(site, entry);
  });
  const never = new AbortController().signal;
  // a body's entry closes when it returns, its visit writes its entry a little later: one bound more
  void stepEntries
    .closedWhere(site.tree, site.runs, never)
    .then(() => site.clock.sleep(site.timeout))
    .then(lift, lift);
}

/** Undoes the open entries the unwind covers, newest first (see above). */
export async function unwound(site: UnwindSite): Promise<Unwound> {
  await bodiesSettled(site);
  const done = new Set<string>();
  const closed: CompensationEntry[] = [];
  const usage: UsageRecord[] = [];
  for (let open = openNow(site, done); open.length > 0; open = openNow(site, done)) {
    for (const entry of open) {
      done.add(entry.key);
      const ran = await undone(entry, site.undoSiteOf(entry));
      site.parts?.registry.write(site.tree, [ran.entry]);
      await site.onUndone?.(ran.entry);
      closed.push(ran.entry);
      usage.push(...ran.usage);
    }
  }
  seal(site);
  const failures = closed.flatMap((entry) =>
    entry.undo?.status === CompensationStatus.Failed ? [entry.undo] : [],
  );
  return { closed, usage, failures };
}
