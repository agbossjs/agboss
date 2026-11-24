/**
 * The workflow's graph (the root entry, #272): the path builder (`start`, `agent`, `router`, `action`,
 * `workflow`, `question`, `route`, `caseOf`, the side-path starters), the decorators
 * with their `<Kind>Options`, the handler contracts, the DTO wrappers, the tables
 * `.agboss/types.d.ts` fills and their lookups, and the workflow settings and limits.
 */
export {
  onAction,
  onAgent,
  anyOf,
  caseOf,
  group,
  onExternalTask,
  route,
  onRouter,
  onStart,
  toAction,
  toAgent,
  toFinish,
  toExternalTask,
  toRouter,
  toWorkflow,
  onWorkflow,
} from "../flow/builder.js";
export {
  Metadata,
  type MetadataFacade,
  type MetadataOptions,
  type Tracked,
  type Untracked,
  type ValueMetadata,
} from "../flow/metadata.js";
export { ChildPlacement, type ChildStepOptions } from "../flow/child-placement.js";

export type {
  AfterStep,
  AfterValue,
  BuiltPath,
  CaseHead,
  CasePath,
  ErrorHandling,
  GroupHead,
  PathHead,
  RouteContinuation,
  RouteHead,
  RoutePath,
  RouterStep,
  SideHead,
  SidePath,
  SourceHead,
  Switching,
  Transitions,
} from "../flow/builder-types.js";
export type {
  AgentsLaunched,
  JoinErrorHandling,
  Joined,
  Launched,
  ChildLaunchCheck,
  LaunchOptions,
  Launches,
  RouterLaunches,
  WorkflowLaunchOptions,
} from "../flow/launch-types.js";
export type {
  GroupPath,
  GroupStart,
  GroupsJoined,
  QuorumGroupsOptions,
  QuorumJoined,
  QuorumOptions,
  Quorums,
} from "../flow/quorum-types.js";
export type { AnyOfArbiters, ArbiterChoice } from "../flow/quorum-step.js";
export {
  NodeKind,
  QuorumKind,
  StepKind,
  type AcceptedBy,
  type ArbiterClass,
  type ChooseOneRoute,
  type ChooseOneStep,
  type CountQuorum,
  type ErrorClass,
  type FlowPath,
  type GroupsQuorum,
  type JoinErrorHandler,
  type JoinStep,
  type LaunchStep,
  type LaunchTargetKind,
  type OneOfStep,
  type OnFinishStep,
  type OnErrorStep,
  type PathSource,
  type Quorum,
  type QuorumGroup,
  type Step,
  type SubPath,
  type SwitchCase,
  type SwitchStep,
  type ToStep,
} from "../flow/ast.js";
export { Agent, type AgentOptions } from "../flow/decorators/agent.js";
export { Action, type ActionOptions } from "../flow/decorators/action.js";
export {
  Arbiter,
  OnAnswer,
  type AnswerJudgement,
  type ArbiterAnswerOf,
  type ArbiterCriterion,
  type ArbiterDecorator,
  type ArbiterOptions,
  type CodeArbiterOptions,
  type ModelArbiterOptions,
  type OnAnswerDecorator,
} from "../flow/decorators/arbiter.js";
export {
  DecidedBy,
  FailurePolicy,
  Router,
  SpawnPolicy,
  type CodeRouterOptions,
  type CodeRouterRoute,
  type ModelRouterOptions,
  type RouterOptions,
  type RouterRoute,
} from "../flow/decorators/router.js";
export { WorkflowStart, type WorkflowStartOptions } from "../flow/decorators/workflow-start.js";
export { WorkflowFinish, type WorkflowFinishOptions } from "../flow/decorators/workflow-finish.js";
export {
  Workflow,
  type FlowDefaults,
  type GuardrailDefaults,
  type ModelDefaults,
  type RouterDefaults,
  type ToolDefaults,
  type WorkflowDefaults,
  type WorkflowOptions,
} from "../flow/decorators/workflow.js";
export type { InputFieldShape, InputFields } from "../flow/decorators/declaration.js";
export type { ActionHandler, ActionResult, RouterHandler } from "../flow/handlers.js";
export {
  historyOf,
  isVariant,
  listOf,
  oneOf,
  optional,
  variant,
  type HistoryOf,
  type HistoryOptions,
  type HistoryWrapper,
  type ListWrapper,
  type OneOfWrapper,
  type OptionalWrapper,
  type OutputShape,
  type Produced,
  type ProducedValue,
  type ValueOf,
  type ValueShape,
  type Variant,
  type VariantOf,
} from "../flow/dto-wrappers.js";
export {
  type AGBossTypes,
  agbossComponent,
  agbossDto,
  type ChannelAnswerOf,
  type ChannelQuestionOf,
  type ExecutionInputOf,
  type ExecutionOptionsArgs,
  type ExecutionOptionsOf,
  type ExecutionOutputOf,
  type GeneratedTypeError,
  type InputOf,
  type MissingGeneratedTypes,
  type NoInput,
  type NoOutput,
  type OutputOf,
  type PauseInputOf,
  type PauseOutputOf,
  type Route,
  type RouterAnswerOf,
} from "../flow/generated-types.js";
export type { ComponentRecord } from "../flow/runtime/records.js";
export type { ExecutionRecord, PauseAnswerRecord } from "../flow/runtime/execution-record.js";
export {
  ComponentKind,
  OutdatedReason,
  type OutdatedMark,
  type OutdatedValueRecord,
  type OutdatedValueReference,
  type ScopeValueRecord,
  type ScopeValueReference,
} from "../flow/runtime/records.js";
export {
  WorkflowSettings,
  type WorkflowDefinition,
  type WorkflowSettingsBuilder,
} from "../graph/settings.js";
