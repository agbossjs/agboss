import type {
  ChooseOneStep,
  JoinErrorHandler,
  Quorum,
  OnErrorStep,
  PathSource,
  Step,
  SwitchStep,
} from "../ast.js";
import type { RuleViolation } from "../../graph/rule-error.js";
import type { OneOfWrapper } from "../dto-wrappers.js";
import type { ComponentName } from "../registry.js";
import type { FlowGraph, FlowLaunch } from "./flow-graph.js";

/** What one walk over a flow's paths gives the rules (`walk.ts`). */

/** How a node is mentioned: entered (`.to…(X)`, `route(X)`), or as the source of its own path. */
export enum MentionKind {
  Entry = "entry",
  OwnPath = "own-path",
}

export interface Mention {
  readonly node: ComponentName;
  readonly kind: MentionKind;
  /** Steps follow it right there: it is continued at this mention. */
  readonly isContinued: boolean;
}

/** A node mention with its nesting level inside its path (0 at the path's top level). */
export interface Placement {
  readonly node: ComponentName;
  readonly depth: number;
  readonly path: PathSource;
}

/** A `switch`, `chooseOne` or `onError` step and the node it follows. */
export interface BranchSite<TStep extends Step> {
  readonly node: ComponentName;
  readonly step: TStep;
}

/** A `.switch(…)` and the `.returns(oneOf(…))` written before it (#299 S54 c). */
export interface SwitchSite extends BranchSite<SwitchStep> {
  readonly returned?: OneOfWrapper;
}

/** One `.onJoinError(E, …)` and the launch whose join it follows (#273). */
export interface JoinErrorSite {
  readonly node: ComponentName;
  readonly launch: FlowLaunch;
  readonly handler: JoinErrorHandler;
}

/** A quorum join (#279) and the launch it counts the answers of. */
export interface QuorumSite {
  readonly node: ComponentName;
  readonly launch: FlowLaunch;
  readonly quorum: Quorum;
}

export interface WalkedFlow {
  readonly graph: FlowGraph;
  readonly mentions: readonly Mention[];
  readonly placements: readonly Placement[];
  readonly switches: readonly SwitchSite[];
  readonly choices: readonly BranchSite<ChooseOneStep>[];
  readonly errorHandlers: readonly BranchSite<OnErrorStep>[];
  /** Every parallel launch, in the order written (#273). */
  readonly launches: readonly FlowLaunch[];
  readonly joinErrorHandlers: readonly JoinErrorSite[];
  /** Every `.joinQuorum(…)` / `.joinQuorumGroups(…)`, in the order written (#279). */
  readonly quorumJoins: readonly QuorumSite[];
  readonly violations: readonly RuleViolation[];
}
