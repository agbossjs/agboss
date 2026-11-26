import { ComponentKind } from "../records.js";
import { errorRecordOf } from "../../../core/error-record.js";
import type { ExecutionTree } from "../../../infrastructure/execution-tree.repository.js";
import { slotOfDto, slotOfField } from "../../analyse/scope.js";
import { actionDeclarationOf, undoOf } from "../../analyse/compensation.js";
import {
  CompensationEntryStatus,
  CompensationReason,
  CompensationStatus,
  type CompensationEntry,
  type CompensationRecord,
  type VisitCompensationSite,
} from "../../compensation.js";
import type { StepRecord } from "../../context/execution-context.js";
import { rootFactsOf } from "../../context/frame.js";
import type { ActionDeclaration } from "../../decorators/declaration.js";
import { stepRecordOf } from "../../observers/execution-event.js";
import { valueIdOf, type ScopeRecords } from "../records.js";
import { holderOf, isOwnEntry, movedToParent } from "./held-entries.js";

/**
 * What one visit does to the execution's undoable actions (#340): an action with `compensateWith`
 * that succeeded opens an entry — its step, its undo and committer by name, and what its undo reads
 * from the scope right after it (a branch's: the scope at the launch and its own value); the
 * committing action commits the open entries it commits; an undo action on a side path closes the
 * newest open entry it undoes (`CompensationReason.SidePath`: `Compensated`, or `Failed` with its
 * error when its own `.onError` took the failure); a root's finish commits the open entries without
 * `committedBy`, a child's moves every open one it holds up to its parent (#1281b). Each entry
 * written is mirrored in the instance's registry at once.
 */

/** A visit as its entries name it: its step, execution and tree. */
interface VisitFacts {
  readonly step: StepRecord;
  readonly executionId: string;
  readonly tree: ExecutionTree;
}

const factsOf = ({ frame }: VisitCompensationSite): VisitFacts => ({
  step: stepRecordOf(frame.step),
  executionId: frame.execution.executionId,
  tree: {
    tenantId: frame.execution.tenant.tenantId,
    rootExecutionId: rootFactsOf(frame.execution).executionId,
  },
});

/** The scope the undo reads from: a branch's own value added under its class's slot. */
function scopeAfter(site: VisitCompensationSite, action: ActionDeclaration): ScopeRecords {
  const { branch, node } = site;
  if (branch?.value === undefined) return site.scope;
  const { output } = action.options;
  const { variant, value } = branch.value;
  const dto = variant === undefined ? output : branch.dtos.get(variant);
  if (typeof dto !== "function") return site.scope;
  const slot = slotOfDto(dto);
  const visit = site.frame.step.visitNumber;
  const own = { valueId: valueIdOf(node.id, visit, slot), slot, producer: node.id, value };
  return {
    ...site.scope,
    [slot]: { ...own, ...(variant === undefined ? {} : { variant }), builtFrom: [] },
  };
}

/** The slots the undo reads, as the scope holds them right after the action. */
function snapshotFor(compensator: ActionDeclaration, scope: ScopeRecords): ScopeRecords {
  const slots = Object.values(compensator.options.input ?? {}).map(
    (shape) => slotOfField(shape).slot,
  );
  return Object.fromEntries(
    slots.flatMap((slot) => {
      const record = scope[slot];
      return record === undefined ? [] : [[slot, record]];
    }),
  );
}

/** The entry an undoable action's success opens; none for an action without `compensateWith`. */
function opened(site: VisitCompensationSite, facts: VisitFacts): CompensationEntry | undefined {
  const undoable = undoOf(site.node.component);
  if (undoable === undefined) return undefined;
  const { action: declaration, compensator } = undoable;
  const floor = Math.max(0, ...site.entries.map((entry) => entry.sequence));
  const sequence =
    site.sequence ?? site.parts?.registry.nextSequence(facts.tree, floor) ?? floor + 1;
  const committer = actionDeclarationOf(declaration.options.committedBy)?.options.name;
  return {
    key: facts.step.idempotencyKey,
    executionId: facts.executionId,
    sequence,
    action: site.node.id,
    compensated: facts.step,
    compensator: compensator.options.name,
    ...(committer === undefined ? {} : { committer }),
    ...(site.branch === undefined ? {} : { launchId: site.branch.launchId }),
    ...(site.branch?.branchIndex === undefined ? {} : { branchIndex: site.branch.branchIndex }),
    input: snapshotFor(compensator, scopeAfter(site, declaration)),
    status: CompensationEntryStatus.Open,
  };
}

/** The undo a side path ran, as its entry records it: the visit is the undo action's own. */
function sidePathUndo(
  site: VisitCompensationSite,
  facts: VisitFacts,
  entry: CompensationEntry,
): CompensationRecord {
  const isFailed = site.failure !== undefined;
  return {
    compensated: entry.compensated,
    compensator: facts.step.component,
    reason: CompensationReason.SidePath,
    status: isFailed ? CompensationStatus.Failed : CompensationStatus.Compensated,
    ...(isFailed ? { error: errorRecordOf(site.failure) } : {}),
    startedAt: site.startedAt.toISOString(),
    endedAt: site.endedAt.toISOString(),
  };
}

const withStatus = (
  entry: CompensationEntry,
  status: CompensationEntryStatus,
): CompensationEntry => ({
  ...entry,
  status,
});

/** What an action's visit closes: the newest entry it undoes, the entries it commits. */
function closedByAction(
  site: VisitCompensationSite,
  facts: VisitFacts,
  open: readonly CompensationEntry[],
): CompensationEntry[] {
  const { id } = site.node;
  // a committer or an undo of this workflow's own: a child's moved entry is no node's here (#1281b)
  const own = open.filter(isOwnEntry);
  const undone = own.filter((entry) => entry.compensator === id).at(-1);
  const closed: CompensationEntry[] =
    undone === undefined
      ? []
      : [
          {
            ...withStatus(undone, CompensationEntryStatus.Closed),
            undo: sidePathUndo(site, facts, undone),
          },
        ];
  if (site.failure !== undefined) return closed;
  const committed = own
    .filter((entry) => entry.committer === id && entry !== undone)
    .map((entry) => withStatus(entry, CompensationEntryStatus.Committed));
  return [...closed, ...committed];
}

/** The entries a visit writes: opened, committed or closed; mirrored in the registry. */
export function entriesOfVisit(site: VisitCompensationSite): readonly CompensationEntry[] {
  const facts = factsOf(site);
  const open = site.entries
    .filter((entry) => entry.status === CompensationEntryStatus.Open)
    .sort((first, second) => first.sequence - second.sequence);
  const written: CompensationEntry[] = [];
  const { parent } = site.frame.execution;
  if (site.node.kind === ComponentKind.WorkflowFinish && parent !== undefined) {
    // a child's finish commits nothing (#1281b): its open entries move up to its parent, in the
    // finish's own write — the parent commits or undoes them
    const held = open.filter((entry) => holderOf(entry) === facts.executionId);
    written.push(...movedToParent(held, parent.execution.executionId));
  } else if (site.node.kind === ComponentKind.WorkflowFinish) {
    const commits = open.filter((entry) => entry.committer === undefined);
    written.push(...commits.map((entry) => withStatus(entry, CompensationEntryStatus.Committed)));
  } else {
    written.push(...closedByAction(site, facts, open));
    const entry = site.failure === undefined ? opened(site, facts) : undefined;
    if (entry !== undefined) written.push(entry);
  }
  if (written.length > 0) site.parts?.registry.write(facts.tree, written);
  return written;
}
