import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import type { ChildStart, ChildStartField } from "../child-workflow.js";
import { StartChoice, type ArrivingScope, type ChildChoice } from "../children.js";
import { witnessPath } from "../dataflow.js";
import { shapeLabel } from "../labels.js";
import { slotOf, SlotStatus, type SlotState } from "../scope.js";
import type { AnalysisContext } from "./context.js";

/**
 * The start rules of child workflows (#263): an edge into a child whose value no start takes →
 * `[graph.no-matching-start]` (with the child's starts and their inputs), one that two starts take
 * alike → `[graph.ambiguous-start]` (told apart by a subclass); the chosen start's required fields
 * on every path the edge brings — `[input.missing-on-path]`, `[input.outdated-on-path]`,
 * `[input.several-on-path]`, as for any node's input. Its optional fields may be missing: the same
 * child is entered from parents that have them and parents that do not.
 */

/** `company-check-workflow-start (CompanyDto)`, `x-workflow-start ({ company: CompanyDto, … })`. */
export function startLabel(start: ChildStart): string {
  const [whole] = start.fields;
  if (start.fields.length === 1 && whole?.name === start.name)
    return `${start.name} (${shapeLabel(whole.shape)})`;
  const fields = start.fields.map((field) => `${field.name}: ${shapeLabel(field.shape)}`);
  return `${start.name} ({ ${fields.join(", ")} })`;
}

/** `screening-agent → company-check-workflow per item`: the edge as a message names it. */
export const entryLabel = (found: ChildChoice): string =>
  `${found.entry.edge.from} → ${found.entry.child.name}${found.entry.isPerItem ? " per item" : ""}`;

function noMatch(found: ChildChoice): RuleViolation {
  const { child, value, isPerItem } = found.entry;
  const what =
    value === undefined
      ? "the path into it brings no value to choose one of its starts by"
      : `no start takes ${shapeLabel(value)}${isPerItem ? " (the item)" : ""}`;
  const message =
    `${entryLabel(found)}: ${what} — its starts: ${child.starts.map(startLabel).join(", ")}; ` +
    "return a value one of them takes right before it, or give the child a start that takes it";
  return violation("graph.no-matching-start", message, [child.name]);
}

function ambiguous(found: ChildChoice): RuleViolation {
  const { child, value } = found.entry;
  const taken = value === undefined ? "the value" : shapeLabel(value);
  const message =
    `${entryLabel(found)}: ${found.starts.map((start) => start.name).join(" and ")} all take ` +
    `${taken} — a start is chosen by class: make one start's input a subclass ` +
    `(class QuickCheckRequestDto extends ${taken} {})`;
  return violation("graph.ambiguous-start", message, [child.name]);
}

/** `company-check-workflow ← company-check-workflow-start.company (CompanyDto)`. */
const fieldLabel = (found: ChildChoice, start: ChildStart, field: ChildStartField): string =>
  `${found.entry.child.name} ← ${field.name === start.name ? start.name : `${start.name}.${field.name}`} (${shapeLabel(field.shape)})`;

/** What is wrong with a field's value in one arriving scope, if anything. */
function problemOf(field: ChildStartField, slot: SlotState): RuleViolation["code"] | undefined {
  if (slot.status === SlotStatus.Absent) return "input.missing-on-path";
  if (slot.status === SlotStatus.Outdated) return "input.outdated-on-path";
  return !field.isList && slot.count > 1 ? "input.several-on-path" : undefined;
}

const FIXES: Readonly<Record<string, string>> = {
  "input.missing-on-path": "is not produced on the path",
  "input.outdated-on-path": "is outdated on the path",
  "input.several-on-path": "gets several values on the path",
};

function fieldViolation(
  context: AnalysisContext,
  found: ChildChoice,
  start: ChildStart,
  field: ChildStartField,
): RuleViolation | undefined {
  const bad = found.arriving
    .map((arriving: ArrivingScope) => ({
      arriving,
      code: problemOf(field, slotOf(arriving.scope, field.slot)),
    }))
    .find((candidate) => candidate.code !== undefined);
  if (bad?.code === undefined) return undefined;
  const { edge, child } = found.entry;
  const path = [
    ...witnessPath(context.dataflow, { node: edge.from, key: bad.arriving.from.key }),
    child.name,
  ].join(" → ");
  const message = `${fieldLabel(found, start, field)} ${FIXES[bad.code] ?? ""} ${path} — the child's scope starts with its start input only`;
  return violation(bad.code, message, [child.name]);
}

function inputViolations(context: AnalysisContext, found: ChildChoice): readonly RuleViolation[] {
  const [start] = found.starts;
  if (found.choice !== StartChoice.Chosen || start === undefined) return [];
  return start.fields
    .filter((field) => field.isRequired)
    .flatMap((field) => fieldViolation(context, found, start, field) ?? []);
}

export function childRules(context: AnalysisContext): readonly RuleViolation[] {
  const found = new Map<string, RuleViolation>();
  for (const choice of context.children) {
    const own =
      choice.choice === StartChoice.NoMatch
        ? [noMatch(choice)]
        : choice.choice === StartChoice.Ambiguous
          ? [ambiguous(choice)]
          : inputViolations(context, choice);
    for (const problem of own) found.set(`${problem.code}|${problem.message}`, problem);
  }
  return [...found.values()];
}
