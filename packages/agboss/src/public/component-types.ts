/**
 * The types the component decorators and the settings are made of (#895): their options and the
 * metadata they record, so a signature that names them can be named by a user. Types only: it is
 * re-exported with `export type *`, so it is no module the root import loads.
 */
export { type ChannelRoleForm } from "../channels/channel-role.decorator.js";
export { type AutoDecision } from "../channels/test-channels.js";
export { type CustomCompactionOptions } from "../compaction/compaction.decorator.js";
export { type BindToolOptions } from "../components/bind-tool.js";
export { type ResolvedAll } from "../components/injection.js";
export {
  type AgentMeta,
  type ChannelMeta,
  type CompactionFields,
  type GuardrailFields,
  type PiiPolicyFields,
  type ToolInterceptorFields,
} from "../components/meta-types.js";
export { type GuardrailDecorator } from "../components/policy-decorators.js";
export { type AgentSettingsOf } from "../config/types.js";
export { type ModelGateway } from "../llm/gateway.js";
export { type PiiRefusalShape } from "../pii/pii-policy.decorator.js";
export { type RouteOutcome, type RouteRequest } from "../routers/index.js";
export { type AgentToolClass } from "../components/decorators.js";
export { type Resolved } from "../components/injection.js";
export { type RagBinding } from "../components/meta-types.js";
export { type AgentSettings } from "../config/types.js";
export { type DecisionOutcome } from "../llm/decision-response.js";
export { type ChatModelSpec, type DecideSpec, type DecisionSpec } from "../llm/gateway.js";
export { type RouteOption, type RouterDecision } from "../routers/index.js";
export { type ChatModelUser, type DecisionModel } from "../llm/gateway.js";
export { type ReplyInterpreterInput } from "../channels/reply-reader.js";
export { type QuestionRoleClass } from "../components/decorators.js";
