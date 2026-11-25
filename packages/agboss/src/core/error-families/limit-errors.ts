import { defineFamily, type FamilyConstructor, type PaidErrorVariant } from "./family.js";
import type { BudgetPeriod, BudgetScope, BudgetUnit } from "../../budgets/budget.js";
import type { WorkflowRecord } from "../../flow/context/execution-context.js";
import type { ComponentRecord } from "../../flow/runtime/records.js";
import type { MeshEntry, MeshHop } from "../../mesh/mesh-hop.js";
import { plainly } from "./family.js";
import { countedMessageOf, LIMIT_SPECS } from "./limit-error-specs.js";
import { MESH_LIMIT_SPECS } from "./mesh-limit-specs.js";
import type { Milliseconds, Usd } from "../../units/index.js";
// a paid family: its errors read their spend through the report finops/cost-report sets
import "../../finops/cost-report.js";

/** The kinds of `LimitError`: `switch (error.kind)` is exhaustive. */
export enum LimitErrorKind {
  Budget = "budget",
  /** An agent crossed one of its own limits (`maxModelCalls`, `maxToolCalls`, …). */
  Agent = "agent",
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
  | LimitError.Agent
  | LimitError.Deadline
  | LimitError.Items
  | LimitError.Steps
  | LimitError.Visits
  | LimitError.Depth
  | LimitError.Hops
  | LimitError.MeshLoop;

/** The variants of `LimitError`, each with the facts it carries. */
export declare namespace LimitError {
  /** Where the execution was and what it spent when the limit was hit. */
  interface Where {
    readonly path: readonly string[];
    readonly spentUsd: Usd;
  }
  /** What a counted limit says: the value it allows and the one that crossed it. */
  interface Counted {
    readonly limit: number;
    readonly actual: number;
    /** What the limit is keyed by (`maxSteps`, `<node>.maxVisits`, …). */
    readonly key?: string | undefined;
  }
  /** A budget is exhausted. */
  export type Budget = PaidErrorVariant<LimitErrorKind.Budget, "limit.budget"> &
    Where &
    Pick<Counted, "limit" | "actual"> & {
      readonly budget: Pick<ComponentRecord, "name">;
      readonly scope: BudgetScope;
      readonly period?: BudgetPeriod | undefined;
      readonly key: string;
      readonly unit: BudgetUnit;
      readonly maxSpend?: Usd | undefined;
      readonly spent: Usd;
      readonly maxTokens?: number | undefined;
      readonly usedTokens: number;
    };
  /** An agent crossed one of its own limits. */
  export type Agent = PaidErrorVariant<LimitErrorKind.Agent, "limit.agent"> & Where & Counted;
  /** The execution ran past its deadline. */
  export type Deadline = PaidErrorVariant<LimitErrorKind.Deadline, "limit.deadline"> &
    Where &
    Pick<Counted, "limit" | "actual" | "key"> & {
      /** The duration it was given. */
      readonly deadline: Milliseconds;
      /** When it passed (ISO 8601). */
      readonly deadlineAt: string;
    };
  /** A launch has more items than its limit allows. */
  export type Items = PaidErrorVariant<LimitErrorKind.Items, "limit.items"> &
    Where &
    Counted & { readonly node: string };
  /** The execution took more steps than its workflow allows. */
  export type Steps = PaidErrorVariant<LimitErrorKind.Steps, "limit.steps"> &
    Where &
    Counted & {
      /** The workflow's name. */
      readonly workflow: string;
      readonly workflowRecord?: WorkflowRecord | undefined;
      readonly maxSteps?: number | undefined;
      readonly steps?: number | undefined;
    };
  /** A node was visited more often than its limit allows. */
  export type Visits = PaidErrorVariant<LimitErrorKind.Visits, "limit.visits"> &
    Where &
    Counted & {
      readonly nodeId: string;
      readonly component?: ComponentRecord | undefined;
      readonly maxVisits?: number | undefined;
      readonly visits?: number | undefined;
    };
  /** A recursion went deeper than its workflow allows. */
  export type Depth = PaidErrorVariant<LimitErrorKind.Depth, "limit.depth"> &
    Where &
    Counted & {
      /** The recursive workflow's name. */
      readonly workflow: string;
      readonly workflowRecord?: WorkflowRecord | undefined;
      readonly maxDepth?: number | undefined;
      readonly depth?: number | undefined;
    };
  /** What a mesh limit knows besides the numbers: the chain the request came through. */
  interface Mesh {
    /** The receiver's application and start, as one line: `billing-application › billing-workflow-start`. */
    readonly entry: string;
    readonly meshEntry?: MeshEntry | undefined;
    /** The applications the request passed through, the first caller first. */
    readonly callChain?: readonly MeshHop[] | undefined;
    /** Whether a peer reported it (its names are in `meshEntry` and `callChain`, never in the message). */
    readonly isRemote?: boolean | undefined;
  }
  /** A call crossed more mesh hops than the limit allows. */
  export type Hops = PaidErrorVariant<LimitErrorKind.Hops, "limit.hops"> &
    Where &
    Counted &
    Mesh & {
      /** The receiver's `@Application({ maxMeshHops })`. */
      readonly maxMeshHops?: number | undefined;
      readonly hops?: number | undefined;
    };
  /** A mesh call came back to an entry it was already in. */
  export type MeshLoop = PaidErrorVariant<LimitErrorKind.MeshLoop, "limit.mesh-loop"> &
    Where &
    Counted &
    Mesh;
}

/** The facts a limit error derives itself (its numbers, its key, where the execution was). */
export interface LimitDefaulted {
  Budget: "limit" | "actual" | "unit" | "usedTokens";
  Deadline: "limit" | "actual" | "key" | "path" | "spentUsd";
  Steps: ("limit" | "actual" | "key" | "path" | "spentUsd") | "workflow";
  Visits: ("limit" | "actual" | "key" | "path" | "spentUsd") | "nodeId";
  Depth: ("limit" | "actual" | "key" | "path" | "spentUsd") | "workflow";
  Hops: ("limit" | "actual" | "key" | "path" | "spentUsd") | "entry";
  MeshLoop: ("limit" | "actual" | "key" | "path" | "spentUsd") | "entry";
}

/** `LimitError`: the family's constructor and its variants'. */
export const LimitError: FamilyConstructor<
  LimitError,
  {
    Budget: LimitError.Budget;
    Agent: LimitError.Agent;
    Deadline: LimitError.Deadline;
    Items: LimitError.Items;
    Steps: LimitError.Steps;
    Visits: LimitError.Visits;
    Depth: LimitError.Depth;
    Hops: LimitError.Hops;
    MeshLoop: LimitError.MeshLoop;
  },
  LimitDefaulted
> = defineFamily({
  name: "LimitError",
  code: "limit",
  kinds: LimitErrorKind,
  paid: true,
  variants: {
    Budget: LIMIT_SPECS.budget,
    Agent: plainly([countedMessageOf], ["key"], "an agent crossed one of its own limits"),
    Deadline: LIMIT_SPECS.deadline,
    Items: ["a launch has more items than its limit allows"],
    Steps: LIMIT_SPECS.steps,
    Visits: LIMIT_SPECS.visits,
    Depth: LIMIT_SPECS.depth,
    Hops: MESH_LIMIT_SPECS.hops,
    MeshLoop: MESH_LIMIT_SPECS.meshLoop,
  },
});

export * from "./guardrail-errors.js";
