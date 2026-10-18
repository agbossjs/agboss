import { inputShapesOf, type FlowAnalysis } from "../flow/analyse/analyse.js";
import type { ResolvedField } from "../flow/analyse/fields.js";
import { aboutLabel, shapeLabel } from "../flow/analyse/labels.js";

/**
 * Each node's inputs and who can give them (#270 AC18), as `agboss describe` prints them:
 * `prepare-offer-action ← draft: editor-agent | draft-agent (latest), legal: legal-agent (optional)`.
 * `latest` — several producers reach the field and the newest value wins; a `historyOf` field says
 * so, with its limit (#299); nothing reaches → `none`.
 */

const historyNote = (field: ResolvedField): readonly string[] => {
  if (field.history === undefined) return [];
  const { limit } = field.history;
  return [limit === undefined ? "historyOf" : `historyOf, limit ${String(limit)}`];
};

function fieldText(field: ResolvedField, producers: readonly string[]): string {
  const notes = [
    ...(producers.length > 1 ? ["latest"] : []),
    ...historyNote(field),
    ...(field.isRequired ? [] : ["optional"]),
  ];
  const who = producers.length === 0 ? "none" : producers.join(" | ");
  return `${field.name}: ${who}${notes.length === 0 ? "" : ` (${notes.join(", ")})`}`;
}

/** One line per node that reads the path scope. */
export function inputLines(analysis: FlowAnalysis): readonly string[] {
  return [...analysis.fields].flatMap(([node, fields]) => {
    const shapes = inputShapesOf(analysis, node);
    const declared = fields.filter((field) => !field.isPassThrough);
    if (declared.length === 0) return [];
    const texts = declared.map((field) => {
      const producers = new Set(
        shapes.flatMap((shape) => shape.find((item) => item.name === field.name)?.producers ?? []),
      );
      return fieldText(field, [...producers].sort());
    });
    return [`${node} ← ${texts.join(", ")}`];
  });
}

/**
 * Each value written with `{ about }` (#271 M2, #299 S54): `reviewer-agent → DraftChangesDto
 * { about: DraftDto }` — the producer, the value, and what it is about (a new value of it outdates
 * the value).
 */
export function aboutLines(analysis: FlowAnalysis): readonly string[] {
  const lines = analysis.graph.edges.flatMap((edge) =>
    edge.writes.flatMap((write) =>
      write.about === undefined
        ? []
        : [`${edge.from} → ${shapeLabel(write.shape)} ${aboutLabel(write.about)}`],
    ),
  );
  return [...new Set(lines)];
}
