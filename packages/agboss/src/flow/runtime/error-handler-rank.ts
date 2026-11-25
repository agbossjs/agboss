import { codeOfErrorClass, errorMatchOf, type ErrorRecord } from "../../core/error-record.js";
import type { FlowEdge } from "../analyse/flow-graph.js";
import type { NodeExits } from "./graph-model.js";

/** How near a handler's class is to a failure: its distance in the class line, then in the cause chain. */
type Rank = readonly [distance: number, depth: number];

const isBefore = (rank: Rank, other: Rank): boolean =>
  rank[0] < other[0] || (rank[0] === other[0] && rank[1] < other[1]);

/** `.onError(Error, …)` (no code) takes everything, last; a class matches by its code; none = no match. */
function rankOf(record: ErrorRecord, code: string | undefined): Rank | undefined {
  if (code === undefined) return [Infinity, Infinity];
  const match = errorMatchOf(record, code);
  return match === undefined ? undefined : [match.distance, match.depth];
}

/** A handler and how near it is. */
interface Ranked {
  readonly edge: FlowEdge;
  readonly rank: Rank;
}

/** The handler of `edge` for `record`, ranked; `undefined` when it does not match or `skip` names it. */
function rankedOf(
  edge: FlowEdge,
  record: ErrorRecord,
  skip: (code: string) => boolean,
): Ranked | undefined {
  if (edge.error === undefined) return undefined;
  const code = codeOfErrorClass(edge.error);
  if (code !== undefined && skip(code)) return undefined;
  const rank = rankOf(record, code);
  return rank === undefined ? undefined : { edge, rank };
}

/**
 * The best handler among `exits` for `record`: the nearest in its class line, then in its cause
 * chain. Handlers on a code `skip` names are not considered.
 */
export function bestHandlerOf(
  exits: Pick<NodeExits, "errors">,
  record: ErrorRecord,
  skip: (code: string) => boolean = () => false,
): FlowEdge | undefined {
  const matches = exits.errors.flatMap((edge) => rankedOf(edge, record, skip) ?? []);
  return matches.reduce<Ranked | undefined>(
    (best, next) => (best === undefined || isBefore(next.rank, best.rank) ? next : best),
    undefined,
  )?.edge;
}
