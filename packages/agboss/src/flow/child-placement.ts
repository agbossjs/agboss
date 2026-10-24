import { FlowSyntaxError } from "./flow-syntax-error.js";

/**
 * Where a child workflow runs (#333 PR 2, ADR-0022): a launch option of `.toWorkflow(W, …)`,
 * `.toParallelWorkflows(W, …)` and `route(W, …)`. `ParentInstance` (the default) — inside its
 * parent's step, on the parent's instance, as before; `AnyInstance` — queued in the application's
 * `ChildExecutionQueueRepository` and claimed by any instance with a free step slot (#332), the
 * parent waiting for it at its node.
 */
export enum ChildPlacement {
  /** On the parent's instance, inside its parent's step (the default). */
  ParentInstance = "parent-instance",
  /** On any instance of the application that claims it from the shared queue. */
  AnyInstance = "any-instance",
}

/** The options of one child step: `.toWorkflow(W, { placement })`, `route(W, { placement })`. */
export interface ChildStepOptions {
  /** Where the child runs; `ChildPlacement.ParentInstance` when absent. */
  readonly placement?: ChildPlacement;
}

const PLACEMENTS: ReadonlySet<unknown> = new Set(Object.values(ChildPlacement));

/** Whether `value` is a placement (untyped code may pass anything). */
export const isChildPlacement = (value: unknown): value is ChildPlacement => PLACEMENTS.has(value);

/**
 * The `placement` of a child step's options (#333 PR 2): `undefined` when absent; anything but a
 * `ChildPlacement` is refused (untyped code).
 */
export function placementOptionOf(options: unknown, call: string): ChildPlacement | undefined {
  if (options === undefined) return undefined;
  if (typeof options !== "object" || options === null)
    throw new FlowSyntaxError(`${call} takes an options object`);
  const placement: unknown = Reflect.get(options, "placement");
  if (placement === undefined || isChildPlacement(placement)) return placement;
  throw new FlowSyntaxError(
    `${call} takes a ChildPlacement: ChildPlacement.ParentInstance or ChildPlacement.AnyInstance`,
  );
}
