import type { FlowEdge, ValueWrite } from "../../analyse/flow-graph.js";
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
 * other; they are written at once, in one outdating cascade. After a quorum (#279) only the counted
 * answers are gathered, in counting order, on the edge the quorum takes (a group's own).
 */

/** What a join reads: its launch, the branches' tickets and records, the scope at the launch. */
export interface JoinSite {
  readonly launch: RuntimeLaunch;
  /** The join edge taken: the launch's, or the winning group's. */
  readonly edge: FlowEdge;
  readonly ticket: LaunchTicket;
  /** The finished branches' records, by ticket index — a quorum's counted ones in counting order. */
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
  const { launch, groups } = site.edge.join ?? { launch: site.launch.launch, groups: [] };
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

/** Who gave a value: its one branch, or every branch of a list (each element's when they differ). */
interface Producers {
  readonly producer: string;
  readonly elementProducers?: readonly string[];
  readonly valueId: string;
}

function producersOf(
  site: JoinSite,
  gathered: readonly Gathered[],
  slot: string,
  asList: boolean,
): Producers {
  const [first] = gathered;
  const { launcher, visitNumber } = site.ticket;
  if (!asList && first !== undefined)
    return {
      producer: first.ticket.node,
      valueId: valueIdOf(first.ticket.node, first.ticket.visitNumber, slot),
    };
  const names = gathered.map(({ ticket }) => ticket.node);
  const producer = first?.ticket.node ?? launcher;
  const isMixed = names.some((name) => name !== producer);
  return {
    producer,
    ...(isMixed ? { elementProducers: names } : {}),
    valueId: valueIdOf(launcher, visitNumber, slot),
  };
}

function joinRecord(
  site: JoinSite,
  write: ValueWrite,
  writes: readonly ValueWrite[],
): ScopeValueRecord | undefined {
  const gathered = gatheredFor(site, write);
  const asList = isList(write);
  const [first] = gathered;
  if (first === undefined && !asList) return undefined;
  const slot = slotOfWrite(write);
  const sources = sourcesOf(site, gathered, writes);
  const { builtFrom, about } = writtenProvenanceOf(sources, write, site.scope, writes);
  return {
    ...producersOf(site, gathered, slot, asList),
    slot,
    value: asList ? gathered.map(elementOf) : first?.record.value?.value,
    builtFrom,
    ...(about.length === 0 ? {} : { about }),
  };
}

/** Every value of the join, by slot. */
export function joinValuesOf(site: JoinSite): ScopeRecords {
  const writes = site.edge.join?.values ?? [];
  const records = writes.flatMap((write) => joinRecord(site, write, writes) ?? []);
  return Object.fromEntries(records.map((record) => [record.slot, record]));
}

/** The records of a launch's finished branches, by ticket index. */
export const finishedOf = (
  records: readonly BranchOutcomeRecord[],
): readonly BranchOutcomeRecord[] =>
  records.filter((record) => record.status === BranchStatus.Finished);
