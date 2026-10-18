import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import type { InputFieldShape } from "../../decorators/declaration.js";
import { listOf, Wrapper } from "../../dto-wrappers.js";
import type { ComponentName } from "../../registry.js";
import {
  MAX_SCOPES_PER_NODE,
  statesOf,
  witnessPath,
  type NodeScopes,
  type ScopeState,
} from "../dataflow.js";
import type { ResolvedField } from "../fields.js";
import { shapeLabel } from "../labels.js";
import { slotOf, slotOfValue, SlotStatus, type SlotState } from "../scope.js";
import { aboutTargetsOf } from "./about.js";
import type { AnalysisContext } from "./context.js";

/**
 * The input rules of #270, proved on the reachable abstract scopes (S10): a required field absent
 * in some scope → `[input.missing-on-path]` (with the shortest path to that scope; a
 * `historyOf(XDto)` field also where the latest `XDto` is outdated — it has no current one, #299
 * S56); an `optional` field absent in every scope → `[input.never-produced]`; a single field where
 * one step brought several values → `[input.several-on-path]`; two fields of one node that read
 * one slot → `[flow.ambiguous-field]` (they would read the same value; the earlier versions are
 * `historyOf(XDto)`), unless the node's values are `{ about }` that class (`[io.ambiguous-about]`);
 * a `historyOf` limit that is not a positive integer → `[input.history-limit]`; too many scopes →
 * `[flow.analysis-too-large]`.
 */

const innerShape = (shape: InputFieldShape): InputFieldShape => {
  if (typeof shape === "function") return shape;
  if (shape.kind === Wrapper.Optional) return shape.inner;
  return shape.kind === Wrapper.History ? shape.dto : shape;
};

/** A field has no value to read in a slot: absent, or — for `historyOf` — not current. */
const isMissing = (field: ResolvedField, slot: SlotState): boolean =>
  slot.status === SlotStatus.Absent ||
  (field.history !== undefined && slot.status === SlotStatus.Outdated);

/** A single field whose class came from a join as a list of several values (#273): its list's state. */
function severalJoined(field: ResolvedField, state: ScopeState): SlotState | undefined {
  const inner = innerShape(field.shape);
  if (field.isList || field.history !== undefined || typeof inner !== "function") return undefined;
  const list = slotOf(state.scope, slotOfValue(listOf(inner)));
  return list.status !== SlotStatus.Absent && list.count > 1 ? list : undefined;
}

function pathTo(context: AnalysisContext, node: ComponentName, state: ScopeState): string {
  return witnessPath(context.dataflow, { node, key: state.key }).join(" → ");
}

function fieldViolations(
  context: AnalysisContext,
  node: ComponentName,
  field: ResolvedField,
  states: readonly ScopeState[],
): readonly RuleViolation[] {
  const slots = states.map((state) => ({ state, slot: slotOf(state.scope, field.slot) }));
  const absent = slots.filter(({ slot }) => slot.status === SlotStatus.Absent);
  const found: RuleViolation[] = [];
  const [shallowest] = slots.filter(({ slot }) => isMissing(field, slot));
  const joined = shallowest === undefined ? undefined : severalJoined(field, shallowest.state);
  if (joined !== undefined && shallowest !== undefined) {
    const inner = shapeLabel(innerShape(field.shape));
    const message =
      `${field.label}: ${joined.producers.join(", ")} brings several ${inner} values on the path ` +
      `${pathTo(context, node, shallowest.state)} — declare listOf(${inner}), or give the values different classes`;
    found.push(violation("input.several-on-path", message, [node]));
  } else if (field.isRequired && shallowest !== undefined) {
    const path = pathTo(context, node, shallowest.state);
    const message =
      shallowest.slot.status === SlotStatus.Outdated
        ? `${field.label} has no current ${shapeLabel(innerShape(field.shape))} on the path ${path} — the latest one is outdated; renew it on that path before ${node}`
        : `${field.label} is not produced on the path ${path}`;
    found.push(violation("input.missing-on-path", message, [node]));
  }
  if (!field.isRequired && absent.length === states.length) {
    const message =
      `${field.label} is optional, but no path into ${node} produces it — return ` +
      `${shapeLabel(innerShape(field.shape))} on a path into ${node}, or remove the field`;
    found.push(violation("input.never-produced", message, [node]));
  }
  const several = field.isList ? undefined : slots.find(({ slot }) => slot.count > 1);
  if (several !== undefined) {
    const inner = shapeLabel(innerShape(field.shape));
    const message =
      `${field.label}: ${several.slot.producers.join(", ")} brings ${String(several.slot.count)} ` +
      `values on the path ${pathTo(context, node, several.state)} — declare listOf(${inner}), or ` +
      "give the values different classes";
    found.push(violation("input.several-on-path", message, [node]));
  }
  return found;
}

function ambiguousFields(
  node: ComponentName,
  fields: readonly ResolvedField[],
  about: ReadonlySet<string>,
): readonly RuleViolation[] {
  const bySlot = new Map<string, ResolvedField[]>();
  for (const field of fields.filter((candidate) => !candidate.isPassThrough)) {
    bySlot.set(field.slot, [...(bySlot.get(field.slot) ?? []), field]);
  }
  return [...bySlot]
    .filter(([slot, group]) => group.length > 1 && !about.has(slot))
    .map(([, group]) => {
      const [first] = group;
      const shape = first === undefined ? "" : shapeLabel(innerShape(first.shape));
      const count = group.length === 2 ? "two" : String(group.length);
      const message =
        `${node} has ${count} ${shape} fields (${group.map((field) => field.name).join(", ")}) — ` +
        `they read the same value; read it in one field (historyOf(${shape}) gives the earlier ` +
        "versions too)";
      return violation("flow.ambiguous-field", message, [node]);
    });
}

/** A `historyOf(XDto, { limit })` whose limit is not a positive integer. */
function historyLimits(
  node: ComponentName,
  fields: readonly ResolvedField[],
): readonly RuleViolation[] {
  return fields.flatMap((field) => {
    const limit = field.history?.limit;
    if (limit === undefined || (Number.isInteger(limit) && limit > 0)) return [];
    const message = `${field.label}: limit ${String(limit)} — historyOf(…, { limit }) takes a positive integer, or no limit for every earlier version`;
    return [violation("input.history-limit", message, [node])];
  });
}

/** The slots whose state differs between the node's scopes: what multiplies them. */
function multiplyingSlots(scopes: NodeScopes): readonly string[] {
  const all = [
    ...[...scopes.states.values()].map((state) => state.scope),
    ...(scopes.rejected === undefined ? [] : [scopes.rejected]),
  ];
  const slots = new Set(all.flatMap((scope) => [...scope.keys()]));
  return [...slots]
    .filter((slot) => new Set(all.map((scope) => JSON.stringify(scope.get(slot)))).size > 1)
    .sort();
}

function nodeViolations(
  context: AnalysisContext,
  node: ComponentName,
  about: ReadonlySet<string>,
): readonly RuleViolation[] {
  const fields = context.fields.get(node) ?? [];
  const declared = [...ambiguousFields(node, fields, about), ...historyLimits(node, fields)];
  const scopes = context.dataflow.scopes.get(node);
  if (scopes === undefined) return declared;
  if (scopes.isTooLarge) {
    const message =
      `${node} is reached with more than ${String(MAX_SCOPES_PER_NODE)} path scopes — the slots ` +
      `${multiplyingSlots(scopes).join(", ")} multiply them; move a branch into a child workflow ` +
      "(agboss generate workflow …)";
    return [violation("flow.analysis-too-large", message, [node])];
  }
  const states = statesOf(context.dataflow, node);
  return [...declared, ...fields.flatMap((field) => fieldViolations(context, node, field, states))];
}

export function dataInputRules(context: AnalysisContext): readonly RuleViolation[] {
  const about = aboutTargetsOf(context.graph);
  return [...context.graph.nodes.keys()].flatMap((node) =>
    nodeViolations(context, node, about.get(node) ?? new Set()),
  );
}
