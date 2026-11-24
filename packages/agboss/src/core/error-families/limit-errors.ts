import { defineFamily, type FamilyConstructor, type PaidErrorVariant } from "./family.js";
import type { BudgetPeriod, BudgetScope } from "../../budgets/budget.js";
import type { ComponentRecord } from "../../flow/runtime/records.js";
import type { Milliseconds, Usd } from "../../units/index.js";

/** The kinds of `LimitError`: `switch (error.kind)` is exhaustive. */
export enum LimitErrorKind {
  Budget = "budget",
  Deadline = "deadline",
  Items = "items",
  Steps = "steps",
  Visits = "visits",
  Depth = "depth",
  Hops = "hops",
  MeshLoop = "mesh-loop",
}

/** A limit was hit (#261): the execution fails, never stops quietly, with its path and its spend. Catch the family with `.onError(LimitError, …)` or `err instanceof LimitError`. */
export type LimitError =
  | LimitError.Budget
  | LimitError.Deadline
  | LimitError.Items
  | LimitError.Steps
  | LimitError.Visits
  | LimitError.Depth
  | LimitError.Hops
  | LimitError.MeshLoop;

/** The variants of `LimitError`, each with the facts it carries. */
export declare namespace LimitError {
  /** A budget is exhausted. */
  export type Budget = PaidErrorVariant<LimitErrorKind.Budget, "limit.budget"> & {
    readonly path: readonly string[];
    readonly spentUsd: Usd;
  } & {
    readonly budget: Pick<ComponentRecord, "name">;
    readonly scope: BudgetScope;
    readonly period?: BudgetPeriod | undefined;
    readonly key: string;
    readonly maxSpend: Usd;
    readonly spent: Usd;
  };
  /** The execution ran past its deadline. */
  export type Deadline = PaidErrorVariant<LimitErrorKind.Deadline, "limit.deadline"> & {
    readonly path: readonly string[];
    readonly spentUsd: Usd;
  } & { readonly deadline: Milliseconds; readonly deadlineAt: Date };
  /** A launch has more items than its limit allows. */
  export type Items = PaidErrorVariant<LimitErrorKind.Items, "limit.items"> & {
    readonly path: readonly string[];
    readonly spentUsd: Usd;
  } & { readonly node: string; readonly limit: number; readonly actual: number };
  /** The execution took more steps than its workflow allows. */
  export type Steps = PaidErrorVariant<LimitErrorKind.Steps, "limit.steps"> & {
    readonly path: readonly string[];
    readonly spentUsd: Usd;
  } & { readonly workflow: string; readonly limit: number; readonly actual: number };
  /** A node was visited more often than its limit allows. */
  export type Visits = PaidErrorVariant<LimitErrorKind.Visits, "limit.visits"> & {
    readonly path: readonly string[];
    readonly spentUsd: Usd;
  } & { readonly nodeId: string; readonly limit: number; readonly actual: number };
  /** A recursion went deeper than its workflow allows. */
  export type Depth = PaidErrorVariant<LimitErrorKind.Depth, "limit.depth"> & {
    readonly path: readonly string[];
    readonly spentUsd: Usd;
  } & { readonly workflow: string; readonly limit: number; readonly actual: number };
  /** A call crossed more mesh hops than the limit allows. */
  export type Hops = PaidErrorVariant<LimitErrorKind.Hops, "limit.hops"> & {
    readonly path: readonly string[];
    readonly spentUsd: Usd;
  } & { readonly entry: string; readonly limit: number; readonly actual: number };
  /** A mesh call came back to an entry it was already in. */
  export type MeshLoop = PaidErrorVariant<LimitErrorKind.MeshLoop, "limit.mesh-loop"> & {
    readonly path: readonly string[];
    readonly spentUsd: Usd;
  } & { readonly entry: string; readonly limit: number; readonly actual: number };
}

/** `LimitError`: the family's constructor and its variants'. */
export const LimitError: FamilyConstructor<
  LimitError,
  {
    Budget: LimitError.Budget;
    Deadline: LimitError.Deadline;
    Items: LimitError.Items;
    Steps: LimitError.Steps;
    Visits: LimitError.Visits;
    Depth: LimitError.Depth;
    Hops: LimitError.Hops;
    MeshLoop: LimitError.MeshLoop;
  }
> = defineFamily({
  name: "LimitError",
  code: "limit",
  kinds: LimitErrorKind,
  paid: true,
  variants: {
    Budget: ["a budget is exhausted"],
    Deadline: ["the execution ran past its deadline"],
    Items: ["a launch has more items than its limit allows"],
    Steps: ["the execution took more steps than its workflow allows"],
    Visits: ["a node was visited more often than its limit allows"],
    Depth: ["a recursion went deeper than its workflow allows"],
    Hops: ["a call crossed more mesh hops than the limit allows"],
    MeshLoop: ["a mesh call came back to an entry it was already in"],
  },
});

/** The kinds of `GuardrailError`: `switch (error.kind)` is exhaustive. */
export enum GuardrailErrorKind {
  Blocked = "blocked",
  Failed = "failed",
}

/** A guardrail stopped a step (`Blocked`) or could not decide (`Failed`). */
export type GuardrailError = GuardrailError.Blocked | GuardrailError.Failed;

/** The variants of `GuardrailError`, each with the facts it carries. */
export declare namespace GuardrailError {
  /** A guardrail blocked the content. */
  export type Blocked = PaidErrorVariant<GuardrailErrorKind.Blocked, "guardrail.blocked"> & {
    readonly guardrail: string;
    readonly refusal: string;
    readonly key: string;
    readonly probability: number;
    readonly threshold: number;
  };
  /** A guardrail could not decide. */
  export type Failed = PaidErrorVariant<GuardrailErrorKind.Failed, "guardrail.failed"> & {
    readonly guardrail: string;
  };
}

/** `GuardrailError`: the family's constructor and its variants'. */
export const GuardrailError: FamilyConstructor<
  GuardrailError,
  { Blocked: GuardrailError.Blocked; Failed: GuardrailError.Failed }
> = defineFamily({
  name: "GuardrailError",
  code: "guardrail",
  kinds: GuardrailErrorKind,
  paid: true,
  variants: {
    Blocked: ["a guardrail blocked the content"],
    Failed: ["a guardrail could not decide"],
  },
});

/** The kinds of `PiiError`: `switch (error.kind)` is exhaustive. */
export enum PiiErrorKind {
  Refused = "refused",
  DetectionFailed = "detection-failed",
}

/** A PII policy refused a value (`Refused`) or its detector failed (`DetectionFailed`). */
export type PiiError = PiiError.Refused | PiiError.DetectionFailed;

/** The variants of `PiiError`, each with the facts it carries. */
export declare namespace PiiError {
  /** A PII policy refused the content. */
  export type Refused = PaidErrorVariant<PiiErrorKind.Refused, "pii.refused"> & {
    readonly piiKind: string;
    readonly refusal: string;
  };
  /** A PII detector failed. */
  export type DetectionFailed = PaidErrorVariant<
    PiiErrorKind.DetectionFailed,
    "pii.detection-failed"
  >;
}

/** `PiiError`: the family's constructor and its variants'. */
export const PiiError: FamilyConstructor<
  PiiError,
  { Refused: PiiError.Refused; DetectionFailed: PiiError.DetectionFailed }
> = defineFamily({
  name: "PiiError",
  code: "pii",
  kinds: PiiErrorKind,
  paid: true,
  variants: {
    Refused: ["a PII policy refused the content"],
    DetectionFailed: ["a PII detector failed"],
  },
});
