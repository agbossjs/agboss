import type { ValueWrite } from "../../analyse/flow-graph.js";
import { producersOfSlot } from "../../analyse/join-groups.js";
import { slotOfWrite, writtenValue } from "../../analyse/scope.js";
import { builtFromOf, writtenProvenanceOf, type RuntimeProvenance } from "../provenance.js";
import { valueIdOf, type ScopeRecords, type ScopeValueRecord } from "../records.js";
import {
  BranchStatus,
  type BranchOutcomeRecord,
  type BranchTicket,
  type LaunchTicket,
} from "./records.js";
import type { RuntimeLaunch } from "./runtime-launch.js";

/**
 * What a join writes into the path scope (#273): one value per `.join().returns(…)`, gathered from
 * the branches that finished — a list in the branches' order (listed order, or the items' order:
 * never the order they finished in), a single value from its one branch, nothing for an `optional`
 * one whose branch did not run or dropped out. Each value is built from what its branches read at
 * the launch (a per-item run counts as reading the list), so the join's values never outdate each
 * other; they are written at once, in one outdating cascade.
 */

/** What a join reads: its launch, the branches' tickets and records, the scope at the launch. */
export interface JoinSite {
  readonly launch: RuntimeLaunch;
  readonly ticket: LaunchTicket;
  /** The finished branches' records, by ticket index. */
  readonly finished: readonly BranchOutcomeRecord[];
  readonly scope: ScopeRecords;
  readonly provenance: RuntimeProvenance;
}

/** A finished branch with its ticket. */
interface Gathered {
  readonly ticket: BranchTicket;
  readonly record: BranchOutcomeRecord;
}

const elementOf = ({ record }: Gathered): unknown => {
  const given = record.value;
  return given?.variant === undefined
    ? given?.value
    : { variant: given.variant, value: given.value };
};

function gatheredFor(site: JoinSite, write: ValueWrite): readonly Gathered[] {
  const { launch, groups } = site.launch.join.join ?? { launch: site.launch.launch, groups: [] };
  const producers = new Set<string>(producersOfSlot(launch, groups, slotOfWrite(write)));
  return site.finished.flatMap((record) => {
    const ticket = site.ticket.branches[record.index];
    return ticket !== undefined && producers.has(ticket.node) ? [{ ticket, record }] : [];
  });
}

/** What the gathered branches built the value from: their reads at the launch, rule 5 respected. */
function sourcesOf(site: JoinSite, gathered: readonly Gathered[], writes: readonly ValueWrite[]) {
  const read = gathered.flatMap(({ ticket, record }) =>
    builtFromOf({ producer: ticket.node, read: record.read, writes }, site.scope, site.provenance),
  );
  return [...new Set(read)].sort();
}

const isList = (write: ValueWrite): boolean => {
  const { value } = writtenValue(write.shape);
  return typeof value !== "function";
};

function joinRecord(
  site: JoinSite,
  write: ValueWrite,
  writes: readonly ValueWrite[],
): ScopeValueRecord | undefined {
  const gathered = gatheredFor(site, write);
  const [first] = gathered;
  const asList = isList(write);
  if (first === undefined && !asList) return undefined;
  const slot = slotOfWrite(write);
  const producers = gathered.map(({ ticket }) => ticket.node);
  const producer = first?.ticket.node ?? site.ticket.launcher;
  const isMixed = producers.some((name) => name !== producer);
  const { builtFrom, about } = writtenProvenanceOf(
    sourcesOf(site, gathered, writes),
    write,
    site.scope,
    writes,
  );
  const valueId =
    asList || first === undefined
      ? valueIdOf(site.ticket.launcher, site.ticket.visitNumber, slot)
      : valueIdOf(first.ticket.node, first.ticket.visitNumber, slot);
  return {
    valueId,
    slot,
    producer,
    ...(asList && isMixed ? { elementProducers: producers } : {}),
    value: asList ? gathered.map(elementOf) : first?.record.value?.value,
    builtFrom,
    ...(about.length === 0 ? {} : { about }),
  };
}

/** Every value of the join, by slot. */
export function joinValuesOf(site: JoinSite): ScopeRecords {
  const writes = site.launch.join.join?.values ?? [];
  const records = writes.flatMap((write) => joinRecord(site, write, writes) ?? []);
  return Object.fromEntries(records.map((record) => [record.slot, record]));
}

/** The records of a launch's finished branches, by ticket index. */
export const finishedOf = (
  records: readonly BranchOutcomeRecord[],
): readonly BranchOutcomeRecord[] =>
  records.filter((record) => record.status === BranchStatus.Finished);
