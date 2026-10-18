import { QuorumKind, type Quorum } from "../../ast.js";
import { BranchVerdict, type BranchOutcomeRecord } from "./records.js";
import { groupOutcomeOf, isGroupsDecided, tally, type GroupPlaces } from "./quorum-groups.js";

/**
 * The quorum of a launch while it runs (#279 S26): kept in the launch registry, per launch id. Each
 * branch's answer, once its arbiter chain is through, is recorded synchronously: accepted answers
 * get a monotonic `acceptedSequence` while the quorum is open — `Counted` — and `Surplus` once it is
 * decided; rejected answers and branches that dropped out leave their place empty. The quorum is
 * decided when `max` answers are counted (`.joinQuorum`), when a group has won (`.joinQuorumGroups`),
 * when it can no longer be reached, when every branch is through, or at the deadline — then the
 * registry cancels the rest. The records decide the outcome (`quorumOutcomeOf`); this state only
 * cancels early.
 */

/** `.joinQuorum({ min, max })`: `max` defaults to `min`. */
interface CountRule {
  readonly kind: QuorumKind.Count;
  readonly min: number;
  readonly max: number;
}

/** `.joinQuorumGroups(…)`: the groups' places, in listed order. */
interface GroupsRule {
  readonly kind: QuorumKind.Groups;
  readonly groups: readonly GroupPlaces[];
}

export type QuorumRule = CountRule | GroupsRule;

/** The rule of a quorum join, with the groups' places by node name. */
export function quorumRuleOf(quorum: Quorum, groups: readonly GroupPlaces[]): QuorumRule {
  if (quorum.kind === QuorumKind.Groups) return { kind: QuorumKind.Groups, groups };
  return { kind: QuorumKind.Count, min: quorum.min, max: quorum.max ?? quorum.min };
}

/** What `accept` gave an answer. */
export interface Acceptance {
  readonly verdict: BranchVerdict.Counted | BranchVerdict.Surplus;
  readonly acceptedSequence?: number;
}

/** A counted answer: its branch (ticket index), its node and its place in the counting order. */
export interface CountedAnswer {
  readonly index: number;
  readonly node: string;
  readonly acceptedSequence: number;
}

/** What a quorum came to, from its branches' records. */
export interface QuorumOutcome {
  readonly isReached: boolean;
  /** The counted answers in counting order — of the winning group's agents for groups. */
  readonly counted: readonly CountedAnswer[];
  /** `.joinQuorumGroups(…)`: the index of the winning group among the listed ones. */
  readonly group?: number;
}

export class QuorumState {
  private readonly pending: Set<number>;
  private readonly counted: CountedAnswer[] = [];
  private isClosed = false;

  constructor(
    private readonly rule: QuorumRule,
    /** Each branch's node, by ticket index. */
    private readonly nodes: readonly string[],
  ) {
    this.pending = new Set(nodes.map((_, index) => index));
  }

  /** An accepted answer: counted while the quorum is open, surplus once it is decided. */
  accept(index: number): Acceptance {
    const isOpen = this.pending.has(index) && !this.isDecided();
    this.pending.delete(index);
    if (!isOpen) return { verdict: BranchVerdict.Surplus };
    const acceptedSequence = this.counted.length + 1;
    this.counted.push({ index, node: this.nodeOf(index), acceptedSequence });
    return { verdict: BranchVerdict.Counted, acceptedSequence };
  }

  /** A rejected answer, or a branch without one (it failed on its own step, or was cancelled). */
  leave(index: number): void {
    this.pending.delete(index);
  }

  /** The deadline passed: no answer counts any more. */
  close(): void {
    this.isClosed = true;
  }

  /** A branch's record read back after a crash or a resume (the checkpoint's pending writes). */
  restore(record: BranchOutcomeRecord): void {
    this.pending.delete(record.index);
    if (record.verdict !== BranchVerdict.Counted || record.acceptedSequence === undefined) return;
    const answer = { index: record.index, node: this.nodeOf(record.index) };
    this.counted.push({ ...answer, acceptedSequence: record.acceptedSequence });
    this.counted.sort((first, second) => first.acceptedSequence - second.acceptedSequence);
  }

  /** Whether the outcome is fixed: the rest of the launch can be cancelled. */
  isDecided(): boolean {
    if (this.isClosed) return true;
    if (this.rule.kind === QuorumKind.Count) return this.isCountDecided(this.rule);
    return isGroupsDecided(this.rule.groups, this.countsByNode(), this.pendingByNode());
  }

  private isCountDecided(rule: CountRule): boolean {
    const counted = this.counted.length;
    return counted >= rule.max || counted + this.pending.size < rule.min || this.pending.size === 0;
  }

  private nodeOf(index: number): string {
    return this.nodes[index] ?? "";
  }

  private countsByNode(): ReadonlyMap<string, number> {
    return tally(this.counted.map((answer) => answer.node));
  }

  private pendingByNode(): ReadonlyMap<string, number> {
    return tally([...this.pending].map((index) => this.nodeOf(index)));
  }
}

/** The counted answers of a launch's records, in counting order. */
export function countedOf(
  records: readonly BranchOutcomeRecord[],
  nodes: readonly string[],
): readonly CountedAnswer[] {
  const counted = records.flatMap(({ index, verdict, acceptedSequence }) =>
    verdict === BranchVerdict.Counted && acceptedSequence !== undefined
      ? [{ index, node: nodes[index] ?? "", acceptedSequence }]
      : [],
  );
  return counted.sort((first, second) => first.acceptedSequence - second.acceptedSequence);
}

/** What the quorum came to, from the records only (S26: the records decide). */
export function quorumOutcomeOf(
  rule: QuorumRule,
  records: readonly BranchOutcomeRecord[],
  nodes: readonly string[],
): QuorumOutcome {
  const counted = countedOf(records, nodes);
  if (rule.kind === QuorumKind.Count) return { isReached: counted.length >= rule.min, counted };
  return groupOutcomeOf(rule.groups, counted);
}
