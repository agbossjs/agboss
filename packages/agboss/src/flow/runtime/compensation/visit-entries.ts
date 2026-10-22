import { errorRecordOf } from "../../../core/error-record.js";
import type { ExecutionTree } from "../../../infrastructure/execution-tree.repository.js";
import { slotOfDto, slotOfField } from "../../analyse/scope.js";
import { actionDeclarationOf } from "../../analyse/compensation.js";
import { NodeKind } from "../../ast.js";
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

/**
 * What one visit does to the execution's undoable actions (#340): an action with `compensateWith`
 * that succeeded opens an entry — its step, its undo and committer by name, and what its undo reads
 * from the scope right after it (a branch's: the scope at the launch and its own value); the
 * committing action commits the open entries it commits; an undo action on a side path closes the
 * newest open entry it undoes (`CompensationReason.SidePath`: `Compensated`, or `Failed` with its
 * error when its own `.onError` took the failure); a finish commits the open entries without
 * `committedBy`. Each entry written is mirrored in the instance's registry at once.
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
function scopeAfter(site: VisitCompensationSite): ScopeRecords {
  const { branch, node } = site;
  if (branch?.value === undefined || node.declaration.kind !== NodeKind.Action) return site.scope;
  const { output } = node.declaration.options;
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
  const declaration = actionDeclarationOf(site.node.component);
  const compensator = actionDeclarationOf(declaration?.options.compensateWith);
  if (declaration === undefined || compensator === undefined) return undefined;
  const floor = Math.max(0, ...site.entries.map((entry) => entry.sequence));
  const sequence = site.parts?.registry.nextSequence(facts.tree, floor) ?? floor + 1;
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
    input: snapshotFor(compensator, scopeAfter(site)),
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
  const undone = open.filter((entry) => entry.compensator === id).at(-1);
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
  const committed = open
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
  if (site.node.kind === NodeKind.Finish) {
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
