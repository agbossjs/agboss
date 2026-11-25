import { type ValueMetadata } from "../metadata.js";
import type { RuntimeGraph } from "./graph-model.js";
import type { ScopeValueRecord } from "./records.js";
import type { ScopeView } from "./scope.js";

/** Where the values of the scope came from (#1274): the metadata the runtime records on what a node reads. */

/** The record of a value by its id, current or outdated: what a value's parents are read from. */
function recordsById(view: ScopeView): ReadonlyMap<string, ScopeValueRecord> {
  return new Map(
    [...Object.values(view.scope), ...view.outdatedValues].map((record) => [
      record.valueId,
      record,
    ]),
  );
}

/** The visit a value was written at: its `valueId` is `<producer>:<visit>/<slot>`. */
function visitOf(record: ScopeValueRecord): number {
  const rest = record.valueId.slice(record.producer.length + 1);
  const visit = Number.parseInt(rest.slice(0, rest.indexOf("/")), 10);
  return Number.isInteger(visit) ? visit : 1;
}

/** Where a value of a record came from (#1274), its parents the values the producer read, resolved on first use. */
export function metadataOf(
  graph: RuntimeGraph,
  view: ScopeView,
  record: ScopeValueRecord,
  producer: string,
  index?: number,
): ValueMetadata | undefined {
  const createdBy = graph.nodes.get(producer)?.component;
  if (createdBy === undefined) return undefined;
  let parents: readonly ValueMetadata[] | undefined;
  const parentsOf = (): readonly ValueMetadata[] => {
    const known = recordsById(view);
    parents ??= Object.freeze(
      record.builtFrom.flatMap((id) => {
        const parent = known.get(id);
        const meta =
          parent === undefined ? undefined : metadataOf(graph, view, parent, parent.producer);
        return meta === undefined ? [] : [meta];
      }),
    );
    return parents;
  };
  return Object.freeze({
    valueId: index === undefined ? record.valueId : `${record.valueId}[${String(index)}]`,
    slot: record.slot,
    createdBy,
    visitNumber: visitOf(record),
    ...(index === undefined ? {} : { itemIndex: index }),
    get parents() {
      return parentsOf();
    },
  });
}
