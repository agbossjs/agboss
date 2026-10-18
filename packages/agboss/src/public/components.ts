/**
 * The components of a workflow (part of the root entry, #195): the tool and service decorators,
 * dependency injection, judges, channels, decisions and environments. The flow's own decorators
 * (`@Agent`, `@Action`, `@Router`, `@WorkflowStart`, `@WorkflowFinish`, `@Workflow`) are in `flow.ts`.
 */
export {
  Injectable,
  Tool,
  BindTool,
  Guardrail,
  PiiPolicy,
  SemanticInboundChannelAdapter,
  InboundChannelAdapter,
  Channel,
  type ChannelHandler,
  type ChannelRequest,
  type ChannelDecision,
  type ToolHandler,
  type ToolOptions,
} from "../components/decorators.js";
export {
  Judge,
  type JudgeHandler,
  type JudgeInput,
  type JudgeMeta,
  JudgeModel,
  type JudgeVerdict,
} from "../components/judge-decorators.js";
export {
  Decision,
  MAX_DECISION_QUESTIONS,
  type AnswerOf,
  type AnswersOf,
  type ChoiceAnswer,
  type ChoiceQuestion,
  type DecisionAnswer,
  type DecisionImage,
  type DecisionQuestion,
  type DecisionQuestions,
  type DecisionRequest,
  type DecisionState,
  ImageDetail,
  type NoulAnswer,
  type NoulQuestion,
  type ScoreAnswer,
  type ScoreQuestion,
} from "../llm/decisions.js";
export { ROUTER_FACTORY } from "../components/runtime.js";
export { SpendRecorder, type ServiceSpend } from "../components/spend-recorder.js";
/** What `ROUTER_FACTORY` makes: a model-backed router a service asks to route (not `@Router`). */
export type { RouterEngine } from "../routers/index.js";
export { ComponentError } from "../components/metadata.js";
export { nameOf, type ComponentName } from "../components/name-of.js";
export {
  PromptError,
  type PromptProblem,
  type PromptProblemCode,
} from "../components/prompt-problems.js";
export type { OnDestroy, OnInit, OnStart, OnStop } from "../components/container/lifecycle.js";
export {
  InjectionToken,
  provide,
  type Class,
  type Provider,
  type ValueProvider,
  type Token,
} from "../components/injection.js";
export type { PromptInput } from "../components/prompt-input.js";
export { file } from "../components/file.js";
export { TerminalUserChannel } from "../channels/terminal-channel.js";
export { AutoApproveChannel, AutoRejectChannel } from "../channels/test-channels.js";
export {
  EmptyEnvironment,
  env,
  secret,
  Secret,
  EnvironmentError,
  EnvironmentErrorCode,
  type Environment,
  type EnvironmentValueOptions,
  type EnvironmentVariableReader,
} from "../environments/index.js";
