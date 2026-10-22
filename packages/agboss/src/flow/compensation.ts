import { AGBossError } from "../core/errors.js";
import type { ErrorRecord } from "../core/error-record.js";
import { NodeKind } from "./ast.js";
import type { StepRecord } from "./context/execution-context.js";
import type { ComponentDeclaration } from "./decorators/declaration.js";
import type { FrameSpec } from "./context/frame.js";
import type { RuntimeNode } from "./runtime/graph-model.js";
import type { NodeValue } from "./runtime/scope.js";
import type { CompensationParts } from "./runtime/compensation/registry.js";
import type { RunnableConfig } from "@langchain/core/runnables";
import { extractRunContext } from "../core/run-context.js";
import { seconds, type Milliseconds } from "../units/index.js";
import type { DtoClass } from "../dto/types.js";
import type { ExecutionStateType } from "./runtime/state.js";
import type { UsageRecord } from "../finops/usage.js";
import type { JoinUnwindSite } from "./runtime/compensation/join-unwind.js";
import type { ComponentRecord, ScopeRecords } from "./runtime/records.js";

/**
 * Declared action compensation at run time (#340): what an undo of an `@Action({ compensateWith })`
 * is recorded as (`result.compensations`, `CompensationRecord`), why it ran (`CompensationReason`),
 * how it ended (`CompensationStatus`) and the error of an automatic undo that failed
 * (`CompensationFailedError`). The runtime that opens, closes and runs them is loaded lazily
 * (`flow/runtime/compensation/`); this module keeps only the public names and the state channel's
 * entry, which the root import needs (QUALITY.md → Design).
 */

/** The default bound of an automatic undo action (`@Application({ compensationTimeout })`). */
export const COMPENSATION_TIMEOUT: Milliseconds = seconds(15);

/** Why an undo action ran. */
export enum CompensationReason {
  /** An `.onError` / `.onJoinError` side path ran it, as `agboss check` requires. */
  SidePath = "side-path",
  /** A join failed after some of its branches finished: their undo ran before `.onJoinError`. */
  JoinFailed = "join-failed",
  /** The execution failed without a finish (an uncaught failure or limit). */
  ExecutionFailed = "execution-failed",
  /** The execution was cancelled (`app.cancel`). */
  ExecutionCancelled = "execution-cancelled",
}

/** How an undo action ended. */
export enum CompensationStatus {
  /** It returned: the step it undoes is undone. */
  Compensated = "compensated",
  /** It threw: the step it undoes may still hold its side effect. */
  Failed = "failed",
}

/** One undo action that ran (`result.compensations`, `CompensationFailedError.failures`). */
export interface CompensationRecord {
  /** The step it undoes: the action's visit (its key, its copy or item). */
  readonly compensated: StepRecord;
  /** The undo action (`compensateWith`). */
  readonly compensator: ComponentRecord;
  /** Why it ran: a side path, a failed join, … */
  readonly reason: CompensationReason;
  /** How it ended. */
  readonly status: CompensationStatus;
  /** What it threw, when it failed. */
  readonly error?: ErrorRecord;
  /** When it started (ISO 8601, the application's `Clock`). */
  readonly startedAt: string;
  /** When it ended (ISO 8601, the application's `Clock`). */
  readonly endedAt: string;
}

const listOf = (failures: readonly CompensationRecord[]): string =>
  failures
    .map(
      (failure) =>
        `${failure.compensator.name} (compensates ${failure.compensated.component.name}): ` +
        (failure.error?.message ?? "failed"),
    )
    .join("; ");

/**
 * An automatic undo failed (#340 Q4): every other undo still ran, then the execution fails with
 * this error — `failures` are the undo actions that threw, `cause` the error that started the undo
 * (`toFailWith(Original)` matches through it). Never taken by `.onError` / `.onJoinError`.
 */
export class CompensationFailedError extends AGBossError {
  /** `compensation.failed`. */
  static override readonly code: string = "compensation.failed";
  override name = "CompensationFailedError";
  /** The undo actions that failed, newest first (each `CompensationStatus.Failed`). */
  readonly failures: readonly CompensationRecord[];

  constructor(failures: readonly CompensationRecord[], cause: unknown) {
    super(`An automatic undo failed — ${listOf(failures)}; the others ran`, { cause });
    this.failures = failures;
  }
}

/** Where an entry of the `compensations` channel stands. */
export enum CompensationEntryStatus {
  /** The action succeeded and nothing committed or undid it yet. */
  Open = "open",
  /** Its committing action succeeded, or a finish was reached: nothing undoes it any more. */
  Committed = "committed",
  /** Its undo action ran (`undo` says how). */
  Closed = "closed",
}

/**
 * One undoable action that succeeded, as the execution's state keeps it (internal): the step, its
 * undo and its committer by name, and a snapshot of what the undo reads — its input's slots as the
 * scope held them right after the action.
 */
export interface CompensationEntry {
  /** The compensated step's idempotency key: the entry's identity. */
  readonly key: string;
  readonly executionId: string;
  /** Its place in the order the tree's undoable actions succeeded in: undone newest first. */
  readonly sequence: number;
  /** The action's node id (the launched node of a branch). */
  readonly action: string;
  readonly compensated: StepRecord;
  /** The undo action's name. */
  readonly compensator: string;
  /** The committing action's name; absent: a finish commits it. */
  readonly committer?: string;
  /** The launch whose branch it is (#273); absent outside a launch. */
  readonly launchId?: string;
  /** What the undo reads, by slot: as the scope held it right after the action. */
  readonly input: ScopeRecords;
  readonly status: CompensationEntryStatus;
  /** The undo that ran, once `Closed`. */
  readonly undo?: CompensationRecord;
}

/** The channel's reducer: an entry written again replaces the older one and moves to the end. */
export const mergeCompensations = (
  left: readonly CompensationEntry[],
  right: readonly CompensationEntry[],
): CompensationEntry[] => {
  const keys = new Set(right.map((entry) => entry.key));
  return [...left.filter((entry) => !keys.has(entry.key)), ...right];
};

/** Whether any entry is still open. */
export const hasOpenCompensations = (entries: readonly CompensationEntry[]): boolean =>
  entries.some((entry) => entry.status === CompensationEntryStatus.Open);

/** The undo actions that ran, in the order they ended (`result.compensations`). */
export const compensationRecordsOf = (
  entries: readonly CompensationEntry[] | undefined,
): readonly CompensationRecord[] => (entries ?? []).flatMap((entry) => entry.undo ?? []);

/** Whether a graph has an action that declares its undo: only then can its executions open an entry. */
export const hasUndoableActions = (graph: {
  readonly nodes: ReadonlyMap<string, DeclaredNode>;
}): boolean =>
  [...graph.nodes.values()].some(
    ({ declaration }) =>
      declaration.kind === NodeKind.Action && declaration.options.compensateWith !== undefined,
  );

/** A node as the check below reads it: its id and its declaration. */
interface DeclaredNode {
  readonly id: string;
  readonly declaration: ComponentDeclaration;
}

/**
 * Whether a visit of `node` opens, commits or closes an entry — an action that declares its undo,
 * the committer or the undo of an open entry, a finish with an open entry it commits — so the
 * runtime that does it is loaded (lazily) only then.
 */
export function touchesCompensations(
  node: DeclaredNode,
  entries: readonly CompensationEntry[],
): boolean {
  const { declaration } = node;
  const isAction = declaration.kind === NodeKind.Action;
  if (isAction && declaration.options.compensateWith !== undefined) return true;
  const open = entries.filter((entry) => entry.status === CompensationEntryStatus.Open);
  if (declaration.kind === NodeKind.Finish)
    return open.some((entry) => entry.committer === undefined);
  return (
    isAction && open.some((entry) => entry.committer === node.id || entry.compensator === node.id)
  );
}

/** Where a visit ran and what it left, for its compensation entries. */
export interface VisitCompensationSite {
  readonly node: RuntimeNode;
  /** The execution's entries before the visit. */
  readonly entries: readonly CompensationEntry[];
  readonly frame: FrameSpec;
  /** The scope right after the visit's write. */
  readonly scope: ScopeRecords;
  readonly startedAt: Date;
  readonly endedAt: Date;
  /** What the visit threw, when its `.onError` took it. */
  readonly failure?: unknown;
  readonly parts?: CompensationParts | undefined;
  /** A branch of a launch (#273): its launch, and its own value (written by the join only). */
  readonly branch?: {
    readonly launchId: string;
    readonly value: NodeValue | undefined;
    readonly dtos: ReadonlyMap<string, DtoClass>;
  };
}

/** The entries a visit writes into the `compensations` channel; the runtime loaded only when needed. */
export async function compensationsOfVisit(
  site: VisitCompensationSite,
): Promise<{ readonly compensations?: CompensationEntry[] }> {
  if (!touchesCompensations(site.node, site.entries)) return {};
  const { entriesOfVisit } = await import("./runtime/compensation/visit-entries.js");
  const written = entriesOfVisit(site);
  return written.length === 0 ? {} : { compensations: [...written] };
}

/** A branch of a launch that ended with its node's answer (#273). */
export interface BranchCompensationSite {
  readonly node: RuntimeNode;
  /** The state the branch ran on: the scope at the launch. */
  readonly view: ExecutionStateType;
  readonly frame: FrameSpec;
  readonly config: RunnableConfig | undefined;
  readonly branch: { readonly launchId: string; readonly value: NodeValue | undefined };
  readonly deps: {
    readonly graph: { readonly dtos: ReadonlyMap<string, DtoClass> };
    readonly compensation?: CompensationParts | undefined;
  };
}

/** The entry an undoable action's branch opens as it ends: undone by its join when it fails. */
export function compensationsOfBranch(
  site: BranchCompensationSite,
): Promise<{ readonly compensations?: CompensationEntry[] }> {
  const { node, view, frame, deps } = site;
  const now = extractRunContext(site.config, view.runId).clock.now();
  const branch = { ...site.branch, dtos: deps.graph.dtos };
  const scope = view.scope;
  const parts = deps.compensation;
  return compensationsOfVisit({
    node,
    entries: view.compensations,
    frame,
    scope,
    branch,
    parts,
    startedAt: now,
    endedAt: now,
  });
}

/** What a failed join's undo writes when a side path takes the failure: its entries and spend. */
export interface FailedJoinUndo {
  readonly compensations?: CompensationEntry[];
  readonly usage?: UsageRecord[];
}

/**
 * A failed join undoes its finished undoable branches before `.onJoinError` or the failure (#340
 * Q3): the runtime is loaded only for a launch of an action that declares its undo.
 */
export async function compensationsOfFailedJoin(site: JoinUnwindSite): Promise<FailedJoinUndo> {
  const isUndoable = site.ticket.branches.some((branch) => {
    const declaration = site.deps.graph.nodes.get(branch.node)?.declaration;
    return (
      declaration?.kind === NodeKind.Action && declaration.options.compensateWith !== undefined
    );
  });
  if (!isUndoable) return {};
  const { unwoundJoin } = await import("./runtime/compensation/join-unwind.js");
  return unwoundJoin(site);
}
