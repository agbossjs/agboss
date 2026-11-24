/**
 * The parallel launches of the flow DSL (#1279, #1280): `inParallel([…])`, `forEachItem(step, …)`,
 * `skip()`, their options and the steps they write into the AST. Re-exported by the root entry.
 */
export { forEachItem, inParallel, skip, type Skip } from "../flow/builder.js";
export type {
  ForEachItemStep,
  InParallelStep,
  ParallelBranchStep,
  ParallelTargetKind,
} from "../flow/ast.js";
export type {
  ForEachItemOptions,
  ItemsLaunched,
  MaxItemsOptions,
  NeedsItemsHandler,
  NeedsItemsQuorumHandler,
  PerItemArbitratedQuorums,
  PerItemLaunched,
  TakeFirstLaunched,
  TakeFirstOptions,
  ParallelLaunches,
  ParallelOptions,
} from "../flow/launch-types.js";
export type { ParallelLaunchRuleCode } from "../graph/extra-rule-codes.js";
