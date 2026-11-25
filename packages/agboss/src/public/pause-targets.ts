// The pause targets (#1307a, #1310c): `@ToolApproval`, `@ExternalTask`, their selector, interpreter and contexts.
export {
  ExternalTask,
  PauseRespondent,
  ToolApproval,
  type AnyPauseExpiration,
  type ExternalTaskOptions,
  type PauseTargetBaseOptions,
  type ToolApprovalOptions,
} from "../channels/pause-targets.js";
export type {
  AnswerPermissionContext,
  ApprovalDecision,
  AssignContext,
  ChannelSelectContext,
  ExpiredContext,
  PauseActor,
  PauseEscalationLimits,
  PauseToolCallSummary,
  PauseTrailEntry,
  ReassignPermissionContext,
  TimeoutPermissionContext,
  TimeoutResolveContext,
} from "../channels/pause-contexts.js";
export {
  ChannelSelector,
  type ChannelSelectorHandler,
  type ChannelSelectorOptions,
} from "../channels/channel-selector.js";
export {
  ChannelInterpretation,
  ChannelInterpreter,
  type ChannelInterpreterDecorator,
  type ChannelInterpreterHandler,
  type ChannelInterpreterInput,
  type ChannelInterpreterOptions,
  type CodeChannelInterpreterOptions,
  type ModelChannelInterpreterOptions,
  type NotUnderstoodChannelInterpretation,
  type UnderstoodChannelInterpretation,
} from "../channels/channel-interpreter.js";
