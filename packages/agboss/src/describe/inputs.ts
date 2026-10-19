import { inputShapesOf, type FlowAnalysis } from "../flow/analyse/analyse.js";
import { StartChoice, type ChildChoice } from "../flow/analyse/children.js";
import { entryLabel, startLabel } from "../flow/analyse/rules/children.js";
import { NodeKind } from "../flow/ast.js";
import type { ResolvedField } from "../flow/analyse/fields.js";
import { aboutLabel, shapeLabel } from "../flow/analyse/labels.js";
import { launchCounts } from "./launch-counts.js";
import { quorumCounts } from "./quorum-counts.js";

/**
 * Each node's inputs and who can give them (#270 AC18), as `agboss describe` prints them:
 * `prepare-offer-action ← draft: editor-agent | draft-agent (latest), legal: legal-agent (optional)`.
 * `latest` — several producers reach the field and the newest value wins; a `historyOf` field says
 * so, with its limit (#299); a list a quorum counts gives each producer's counts (`critic-agent
 * ×1–2`, #279); nothing reaches → `none`.
 */

const historyNote = (field: ResolvedField): readonly string[] => {
  if (field.history === undefined) return [];
  const { limit } = field.history;
  return [limit === undefined ? "historyOf" : `historyOf, limit ${String(limit)}`];
};

function fieldText(
  field: ResolvedField,
  producers: readonly string[],
  counts: ReadonlyMap<string, string>,
): string {
  const notes = [
    ...(producers.length > 1 ? ["latest"] : []),
    ...historyNote(field),
    ...(field.isRequired ? [] : ["optional"]),
  ];
  const counted = producers.map((producer) => {
    const count = counts.get(producer);
    return count === undefined ? producer : `${producer} ${count}`;
  });
  const who = producers.length === 0 ? "none" : counted.join(" | ");
  return `${field.name}: ${who}${notes.length === 0 ? "" : ` (${notes.join(", ")})`}`;
}

/** One line per node that reads the path scope (a child workflow's start: `childLines`). */
export function inputLines(analysis: FlowAnalysis): readonly string[] {
  return [...analysis.fields].flatMap(([node, fields]) => {
    if (analysis.graph.nodes.get(node)?.kind === NodeKind.Workflow) return [];
    const shapes = inputShapesOf(analysis, node);
    const declared = fields.filter((field) => !field.isPassThrough);
    if (declared.length === 0) return [];
    const texts = declared.map((field) => {
      const producers = new Set(
        shapes.flatMap((shape) => shape.find((item) => item.name === field.name)?.producers ?? []),
      );
      const counts = new Map([
        ...quorumCounts(analysis, node, field),
        ...launchCounts(analysis, node, field),
      ]);
      return fieldText(field, [...producers].sort(), counts);
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

function choiceText(found: ChildChoice): string {
  switch (found.choice) {
    case StartChoice.Chosen:
      return found.starts.map(startLabel).join("");
    case StartChoice.NoMatch:
      return "no start takes its value";
    case StartChoice.Ambiguous:
      return `ambiguous: ${found.starts.map((start) => start.name).join(", ")}`;
  }
}

/**
 * The start each edge into a child workflow enters through (#263):
 * `screening-agent → company-check-workflow per item: company-check-workflow-start (CompanyDto)`.
 */
export function childLines(analysis: FlowAnalysis): readonly string[] {
  return [
    ...new Set(analysis.children.map((found) => `${entryLabel(found)}: ${choiceText(found)}`)),
  ];
}
