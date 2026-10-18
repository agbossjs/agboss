import { violation, type RuleViolation } from "../../../graph/rule-error.js";
import type { ComponentName } from "../../registry.js";
import { statesOf, witnessSteps, type ScopeState, type WitnessStep } from "../dataflow.js";
import type { ResolvedField } from "../fields.js";
import { stepOf } from "../launches.js";
import type { OutdatingStep } from "../outdating.js";
import { scopeKey, slotLabel, slotOf, SlotStatus, type SlotKey } from "../scope.js";
import type { AnalysisContext } from "./context.js";

/**
 * `[input.outdated-on-path]` (#271 rule 6, AC2, AC5): a field — required or `optional` — whose slot
 * holds an outdated value in some reachable scope of its node. A field never reads an outdated
 * value and never falls back to an older one, so the graph does not assemble. The message names
 * the shortest path to that scope and the step that outdated the value: what it was built from (or
 * what it is about) and who replaced it. A `historyOf(XDto)` field is not checked here: its earlier
 * versions are what it reads (#299 S56), and a path without a current `XDto` is
 * `[input.missing-on-path]` (`data-inputs.ts`).
 */

const isOutdated = (state: ScopeState, field: ResolvedField): boolean =>
  slotOf(state.scope, field.slot).status === SlotStatus.Outdated;

/** The two witness steps around the step where the field's value became outdated. */
interface OutdatingSite {
  readonly before: WitnessStep;
  readonly after: WitnessStep;
}

/** The last step of the witness where the field's value became outdated (it stays so after it). */
function outdatingSite(
  steps: readonly WitnessStep[],
  field: ResolvedField,
): OutdatingSite | undefined {
  for (let index = steps.length - 1; index > 0; index -= 1) {
    const before = steps[index - 1];
    const after = steps[index];
    if (before === undefined || after === undefined) return undefined;
    if (isOutdated(after.state, field) && !isOutdated(before.state, field))
      return { before, after };
  }
  return undefined;
}

/** The outdating of one witness step, replayed: the edge taken and the cascade it ran. */
function replay(context: AnalysisContext, site: OutdatingSite): OutdatingStep | undefined {
  const { provenance } = context.dataflow;
  const { before, after } = site;
  return context.graph.edges
    .filter((edge) => edge.from === before.node && edge.to === after.node)
    .flatMap((edge) => stepOf(edge, before.state.scope, provenance))
    .find((step) => scopeKey(step.scope) === after.state.key);
}

/** The cascade from a slot back to the replaced value it started at. */
function causeChain(step: OutdatingStep, slot: SlotKey): readonly SlotKey[] {
  const chain: SlotKey[] = [];
  for (let cause = step.causes.get(slot); cause !== undefined; cause = step.causes.get(cause)) {
    chain.push(cause);
    if (step.replaced.has(cause) || chain.length > step.causes.size) break;
  }
  return chain;
}

/** Why the value is outdated: `about DraftDto, replaced by writer-agent`. */
function reasonOf(
  context: AnalysisContext,
  steps: readonly WitnessStep[],
  field: ResolvedField,
): string {
  const site = outdatingSite(steps, field);
  const step = site === undefined ? undefined : replay(context, site);
  const chain = step === undefined ? [] : causeChain(step, field.slot);
  const [direct] = chain;
  const root = chain[chain.length - 1];
  if (site === undefined || direct === undefined || root === undefined) return "outdated";
  const isAbout = slotOf(site.before.state.scope, field.slot).about.includes(direct);
  const how = `${isAbout ? "about" : "built from"} ${slotLabel(direct)}`;
  const writer = site.before.node;
  return direct === root
    ? `${how}, replaced by ${writer}`
    : `${how}, outdated when ${writer} replaced ${slotLabel(root)}`;
}

function fieldViolation(
  context: AnalysisContext,
  node: ComponentName,
  field: ResolvedField,
): RuleViolation | undefined {
  const found = statesOf(context.dataflow, node).find((state) => isOutdated(state, field));
  if (found === undefined) return undefined;
  const steps = witnessSteps(context.dataflow, { node, key: found.key });
  const path = steps.map((step) => step.node).join(" → ");
  const message =
    `${field.label} is outdated on the path ${path} (${reasonOf(context, steps, field)}) — ` +
    `renew it on that path before ${node}, or read it before it is outdated`;
  return violation("input.outdated-on-path", message, [node]);
}

export function outdatedRules(context: AnalysisContext): readonly RuleViolation[] {
  return [...context.fields].flatMap(([node, fields]) => {
    const scopes = context.dataflow.scopes.get(node);
    // past the scope guard the states are incomplete: `[flow.analysis-too-large]` says so instead
    if (scopes === undefined || scopes.isTooLarge) return [];
    return fields
      .filter((field) => field.history === undefined)
      .flatMap((field) => fieldViolation(context, node, field) ?? []);
  });
}
