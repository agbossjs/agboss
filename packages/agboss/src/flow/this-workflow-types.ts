import type { ErrorClass } from "./ast.js";
import type {
  CaseHead,
  ClaimsOf,
  GroupHead,
  PathHead,
  RouteHead,
  SideHead,
  SidePath,
  SourceHead,
} from "./builder-types.js";
import type { ReturnedShape, ValueOf } from "./dto-wrappers.js";
import type {
  GeneratedTypeError,
  MissingGeneratedTypes,
  NameOf,
  ThisWorkflowOutputs,
} from "./generated-types.js";
import type { AfterReturns, ReturnsArguments, Same, ValuesSource } from "./returns-types.js";
import type { ThisWorkflow } from "./this-workflow.js";

/**
 * `ThisWorkflow` typed per path (#264 S112, S114). `ThisWorkflow` is one class for every recursive
 * workflow, so what it gives cannot be one generated entry: a `.returns(…)` after a `ThisWorkflow`
 * step, or after its per-item join, is not checked where it is written — it is recorded as a claim
 * in the path's head (`claims`), carried through every sub-path into `.switch(…)` / `.chooseOne(…)`
 * / `.onError(…)` / `.onJoinError(…)`, and `@Workflow({ name, flow })` checks the claims of its flow
 * against its own entry, `ThisWorkflowOutputs[name]`: the launch's input problems (`input`), the
 * finishes' outputs (`output`) and the join of a per-item launch (`join`). A wrong class is a compile
 * error on `flow`.
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
          : THead extends GroupHead<
                infer TNames extends string,
                infer TGiven extends readonly unknown[],
                infer TClaims
              >
            ? GroupHead<TNames, TGiven, TClaims | TNew>
            : never;

/** `.toWorkflow(ThisWorkflow).returns(X)` (and `route(…)`, `workflow(…)`): X is what it gives. */
export interface ThisWorkflowStepClaim<TValue> {
  readonly step: TValue;
}

/** `.toParallelWorkflows(ThisWorkflow, …).join().returns(X)`: X is what its children give. */
export interface ThisWorkflowJoinClaim<TValue> {
  readonly join: TValue;
}

/** The values of a `ThisWorkflow` step: its workflow's `ThisWorkflowOutputs` entry. */
export interface ThisWorkflowStepValues extends ValuesSource {
  readonly label: ThisWorkflowName;
  readonly entry: 'ThisWorkflowOutputs["<workflow>"]["output"]';
  readonly takesAbout: true;
  readonly canLaunch: true;
}

/** The values of a per-item `ThisWorkflow` launch's join. */
export interface ThisWorkflowJoinValues extends ValuesSource {
  readonly label: "the join";
  readonly entry: 'ThisWorkflowOutputs["<workflow>"]["join"]';
  readonly takesAbout: true;
  readonly canLaunch: false;
}

/** After a `ThisWorkflow` step: `.returns(…)` names what it gives — claimed, checked by `@Workflow`. */
export interface ThisWorkflowReturning<THead extends PathHead> {
  returns<const TShape extends ReturnedShape>(
    value: TShape,
    ...options: ReturnsArguments<TShape, ThisWorkflowStepValues>
  ): AfterReturns<
    ThisWorkflowStepValues,
    never,
    [ValueOf<TShape>],
    TShape,
    WithClaims<THead, ThisWorkflowStepClaim<ValueOf<TShape>>>
  >;
}

/** After the join of `.toParallelWorkflows(ThisWorkflow, …)`: its `.onJoinError(…)`, its values. */
export interface ThisWorkflowJoined<THead extends PathHead> {
  onJoinError<const TPath extends SidePath>(
    error: ErrorClass,
    path: TPath,
  ): ThisWorkflowJoined<WithClaims<THead, ClaimsOf<TPath>>>;
  returns<const TShape extends ReturnedShape>(
    value: TShape,
    ...options: ReturnsArguments<TShape, ThisWorkflowJoinValues>
  ): AfterReturns<
    ThisWorkflowJoinValues,
    never,
    [ValueOf<TShape>],
    TShape,
    WithClaims<THead, ThisWorkflowJoinClaim<ValueOf<TShape>>>
  >;
}

/** After `.toParallelWorkflows(ThisWorkflow, …)`: only `.join()`. */
export interface ThisWorkflowLaunched<THead extends PathHead> {
  join(): ThisWorkflowJoined<THead>;
}

/** A workflow's `ThisWorkflowOutputs` entry; `MissingGeneratedTypes` before `agboss check`. */
type EntryOf<TName extends string> = TName extends keyof ThisWorkflowOutputs
  ? ThisWorkflowOutputs[TName]
  : MissingGeneratedTypes;

interface StepNotGiven<TName extends string> {
  readonly __error: `a .returns(…) after ThisWorkflow is not what ${TName} gives — see ThisWorkflowOutputs["${TName}"]["output"]`;
}

interface JoinNotGiven<TName extends string> {
  readonly __error: `the .returns(…) after the join of .toParallelWorkflows(ThisWorkflow, …) is not what ${TName}'s children give — see ThisWorkflowOutputs["${TName}"]["join"]`;
}

/** The problem of one claim (distributed over the claims): `never` when the entry agrees. */
type ClaimProblem<TClaim, TEntry, TName extends string> =
  TClaim extends ThisWorkflowStepClaim<infer TValue>
    ? TEntry extends { readonly output: infer TOutput }
      ? Same<TValue, TOutput> extends true
        ? never
        : StepNotGiven<TName>
      : StepNotGiven<TName>
    : TClaim extends ThisWorkflowJoinClaim<infer TValue>
      ? TEntry extends { readonly join: infer TJoin }
        ? Same<TValue, TJoin> extends true
          ? never
          : JoinNotGiven<TName>
        : JoinNotGiven<TName>
      : never;

type ClaimsCheck<TClaims, TEntry, TName extends string> = [TEntry] extends [GeneratedTypeError]
  ? { readonly flow: TEntry }
  : TEntry extends { readonly input: infer TInput }
    ? [TInput] extends [GeneratedTypeError]
      ? { readonly flow: TInput }
      : [ClaimProblem<TClaims, TEntry, TName>] extends [never]
        ? unknown
        : { readonly flow: ClaimProblem<TClaims, TEntry, TName> }
    : never;

/**
 * `@Workflow({ name, flow })`: `unknown` when the flow claims nothing of `ThisWorkflow` or its
 * claims agree with `ThisWorkflowOutputs[name]`; else `{ flow: <the problem> }`, so `flow` does not
 * compile.
 */
export type ThisWorkflowCheck<TName extends string, TFlow extends readonly unknown[]> = [
  ClaimsOf<TFlow[number]>,
] extends [never]
  ? unknown
  : ClaimsCheck<ClaimsOf<TFlow[number]>, EntryOf<TName>, TName>;
