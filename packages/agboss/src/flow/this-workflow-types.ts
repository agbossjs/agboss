import type { ErrorClass } from "./ast.js";
import type {
  CaseHead,
  CasePath,
  ClaimsOf,
  GroupHead,
  PathHead,
  RouteHead,
  BuiltPath,
  SideHead,
  SidePath,
  SourceHead,
  Transitions,
} from "./builder-types.js";
import type {
  GeneratedTypeError,
  MissingGeneratedTypes,
  NameOf,
  ThisWorkflowOutputs,
} from "./generated-types.js";
import type { Launches } from "./launch-types.js";
import type { ThisWorkflow } from "./this-workflow.js";

/**
 * `ThisWorkflow` typed per path (#264 S112, S114). `ThisWorkflow` is one class for every recursive
 * workflow, so what it gives cannot be one generated entry: each `ThisWorkflow` step or per-item
 * launch is recorded as a claim in the path's head (`claims`), carried through every sub-path into
 * `.switch(…)` / `.chooseOne(…)` / `.onError(…)`, and `@Workflow({ name, flow })` checks the
 * launch's input problems (`input`) of its own entry, `ThisWorkflowOutputs[name]`. What a child
 * gives is derived by the analyser (#1270), not typed here: a `ThisWorkflow` step goes on with any
 * transition, and its `oneOf(…)` is switched without a check of its cases.
 */

/** The name of the `ThisWorkflow` marker's node. */
export type ThisWorkflowName = NameOf<ThisWorkflow>;

/** The head with `TNew` claimed too; the same head when nothing is new. */
export type WithClaims<THead extends PathHead, TNew> = [TNew] extends [never]
  ? THead
  : THead extends SourceHead<infer TClaims>
    ? SourceHead<TClaims | TNew>
    : THead extends RouteHead<infer TClaims>
      ? RouteHead<TClaims | TNew>
      : THead extends CaseHead<infer TValue, infer TClaims>
        ? CaseHead<TValue, TClaims | TNew>
        : THead extends SideHead<infer TClaims>
          ? SideHead<TClaims | TNew>
          : THead extends GroupHead<infer TClaims>
            ? GroupHead<TClaims | TNew>
            : never;

/** A `ThisWorkflow` step or launch (and `route(…)`, `onWorkflow(…)`): the path launches it. */
export interface ThisWorkflowClaim {
  readonly launches: true;
}

/** A `oneOf(…)` of `ThisWorkflow` is branched by `.switch(…)`, its cases are checked by the analyser. */
export interface ThisWorkflowSwitching<THead extends PathHead> {
  switch<const TCases extends readonly [CasePath, ...CasePath[]]>(
    ...cases: TCases
  ): BuiltPath<WithClaims<THead, ClaimsOf<TCases[number]>>>;
}

/** After a `ThisWorkflow` step: any transition, or its `oneOf(…)` switched — checked by the analyser. */
export type ThisWorkflowStep<THead extends PathHead> = Transitions<
  WithClaims<THead, ThisWorkflowClaim>
> &
  Launches<never, WithClaims<THead, ThisWorkflowClaim>> &
  ThisWorkflowSwitching<WithClaims<THead, ThisWorkflowClaim>>;

/** After the join of `.toParallelWorkflows(ThisWorkflow, …)`: its `.onError(…)`, then a transition. */
export type ThisWorkflowJoined<THead extends PathHead> = {
  onError<const TPath extends SidePath>(
    error: ErrorClass,
    path: TPath,
  ): ThisWorkflowJoined<WithClaims<THead, ClaimsOf<TPath>>>;
} & Transitions<WithClaims<THead, ThisWorkflowClaim>>;

/** After `.toParallelWorkflows(ThisWorkflow, …)`: only `.join()`. */
export interface ThisWorkflowLaunched<THead extends PathHead> {
  join(): ThisWorkflowJoined<THead>;
}

/** A workflow's `ThisWorkflowOutputs` entry; `MissingGeneratedTypes` before `agboss check`. */
export type EntryOf<TName extends string> = TName extends keyof ThisWorkflowOutputs
  ? ThisWorkflowOutputs[TName]
  : MissingGeneratedTypes;

/**
 * `@Workflow({ name, flow })`: `unknown` when the flow launches no `ThisWorkflow` or its launches
 * can be filled from the paths into them (`input` of `ThisWorkflowOutputs[name]`); else
 * `{ flow: <the problem> }`, so `flow` does not compile.
 */
export type ThisWorkflowCheck<TName extends string, TFlow extends readonly unknown[]> = [
  ClaimsOf<TFlow[number]>,
] extends [never]
  ? unknown
  : ClaimsCheck<EntryOf<TName>>;

export type ClaimsCheck<TEntry> = [TEntry] extends [GeneratedTypeError]
  ? { readonly flow: TEntry }
  : TEntry extends { readonly input: infer TInput }
    ? [TInput] extends [GeneratedTypeError]
      ? { readonly flow: TInput }
      : unknown
    : never;
