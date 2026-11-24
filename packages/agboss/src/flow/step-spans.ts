import { captureCallSite, type SourceSpan } from "../core/diagnostics/source-span.js";
import type { Class } from "../components/injection.js";
import type { Step } from "./ast.js";

/**
 * Where each step of a flow is written (#1325c): the call of `.toAgent(X)`, `.onError(…)` in the
 * user's file. They are kept beside the AST, never in it — a step is plain data that equals another
 * step of the same shape — and what a rendered diagnostic underlines.
 */

const spans = new WeakMap<Step, SourceSpan>();

/** Every step with a place, in the order written: a target is looked for among them when a rule is drawn. */
const written: WeakRef<Step>[] = [];

/** Records where `step` was written: the user's call that is running. Returns `step`. */
export function recordStepSpan<TStep extends Step>(step: TStep): TStep {
  const span = captureCallSite();
  if (span === undefined) return step;
  spans.set(step, span);
  written.push(new WeakRef(step));
  return step;
}

/** `to`, written from `from`'s place: a step rebuilt keeps where it was written. */
export function carryStepSpan<TStep extends Step>(from: Step, to: TStep): TStep {
  const span = spans.get(from);
  if (span === undefined) return to;
  spans.set(to, span);
  written.push(new WeakRef(to));
  return to;
}

/** Where `step` is written, when it is known. */
export const stepSpanOf = (step: Step): SourceSpan | undefined => spans.get(step);

/**
 * The classes a step enters: the target of a transition, the targets of a launch. Read when a rule is
 * drawn, never when the step is written — a target may be a thunk of a class declared below.
 */
function targetsOf(step: Step): readonly unknown[] {
  if ("targets" in step) return step.targets;
  return "target" in step ? [step.target] : [];
}

const sameSpan = (a: SourceSpan, b: SourceSpan): boolean =>
  a.file === b.file && a.line === b.line && a.column === b.column;

/**
 * Where a step enters `target`, when exactly one place does (#1325c): a class entered from several
 * places is ambiguous, so none is named.
 */
export function stepSpanOfTarget(target: Class): SourceSpan | undefined {
  const places: SourceSpan[] = [];
  for (const ref of written) {
    const step = ref.deref();
    const span = step === undefined ? undefined : spans.get(step);
    if (step === undefined || span === undefined || !targetsOf(step).includes(target)) continue;
    if (!places.some((place) => sameSpan(place, span))) places.push(span);
  }
  return places.length === 1 ? places[0] : undefined;
}
