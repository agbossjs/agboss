/**
 * The types the options and the settings of the root API name (#895): what a user writes or reads.
 * Types only: re-exported with `export type *`, so it is no module the root import loads.
 */
export { type OnBeforeDestroy, type OnReady } from "../components/container/lifecycle.js";
export { type InjectAs, type PortInstances, type ServiceEntry } from "../components/injection.js";
export {
  type ChannelOptions,
  type TargetChannelOptions,
  type ToolHandlerClass,
} from "../components/decorators.js";
export { type ToolCallContext, type ToolCallResultContext } from "../tool-interceptors/decision.js";
export {
  type AfterToolMethod,
  type BeforeToolMethod,
  type ToolTargets,
} from "../tool-interceptors/hooks.js";
export { type ToolInputOf, type ToolOutputOf, type UnionToIntersection } from "../tools/index.js";
export { type AgentSettings, type AgentSettingsOf } from "../config/types.js";
export { type UnavailableRead } from "../flow/context/errors.js";
export { type ChosenRouterRoute } from "../flow/decorators/router.js";
export { type TargetRef } from "../flow/target-ref.js";
export { type WorkflowStartInput } from "../flow/decorators/workflow-start.js";
export {
  type ListElementOf,
  type ListElementShape,
  type OneOfVariants,
  type OptionalInnerShape,
  type PartialVariant,
  type ReturnedShape,
  type Wrapper,
} from "../flow/dto-wrappers.js";
export { type NodeValue } from "../flow/runtime/scope.js";
export {
  type RouteOption,
  type RouteOutcome,
  type RouteRequest,
  type RouterDecision,
} from "../routers/index.js";
