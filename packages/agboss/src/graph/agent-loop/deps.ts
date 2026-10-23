import { UNREADABLE_ARGUMENTS } from "../../prompts/agents.js";
import type { BudgetCheck } from "../../budgets/execution-budgets.js";
import type { ExecutionObserverManager } from "../../core/observer-manager.js";
import type { AIMessage } from "@langchain/core/messages";
import type { JudgeBinding, ModelBinding } from "../../llm/registry.js";
import type { BaseMemoryStrategy } from "../../memory/types.js";
import type { KnowledgeSource } from "../../rag/types.js";
import type { AnyTool } from "../../tools/index.js";
import type { Bytes } from "../../units/index.js";
import type { AnswerTools } from "../../flow/runtime/answer-tools.js";
import type { PiiPolicySet } from "../../pii/policy-set.js";
import type { RuntimeGuardrail } from "../../guardrails/runtime.js";
import type { ToolInterceptorChains } from "../../tool-interceptors/runtime.js";
import type { ToolCallApproval } from "./approval.js";
import type { JudgePoints } from "./judge-points.js";
import type { AgentLoopLimits } from "./limits.js";
import type { JudgeReplyShape, RunnableJudge } from "../../components/judge-decorators.js";

/** Everything needed to run one configured agent. */
export interface AgentDefinition {
  readonly name: string;
  readonly binding: ModelBinding;
  /** The agent's instructions: static text (#270 Q51). */
  readonly instructions: string;
  readonly tools: readonly AnyTool[];
  /** How it answers with its `output` (S6); none for a text agent. */
  readonly answerTools: AnswerTools;
  readonly limits: AgentLoopLimits;
  /**
   * What its model reads of one tool result (a tool without its own) and of each context-mode
   * knowledge block at most (#336): its workflow's `defaults.tools.maxResultSize`, else 128 KB.
   */
  readonly maxResultSize: Bytes;
  /** What of the thread memory the agent sees; absent = the built-in sliding window. */
  readonly memory?: BaseMemoryStrategy;
  /** Context-mode knowledge bases: retrieved before the first model call. */
  readonly knowledge: readonly KnowledgeSource[];
  /** Quality gates of the reply (`@Agent({ judges })`), each with its own model; none = no gate. */
  readonly judges?: readonly AgentJudge[];
  /** How often a reply the judges rejected is retried before `QualityGateError`; default 0. */
  readonly maxRetries?: number;
}

/** One `@Judge` of an agent: its name, its instance (from the container) and its model (chat or decisions; none for a code judge). */
export interface AgentJudge {
  readonly name: string;
  readonly handler: RunnableJudge;
  /** What it judges (`@Judge({ reply })`): the shape of its input. */
  readonly reply: JudgeReplyShape;
  /** Its model; none for a code judge (`DecidedBy.Code`, #396). */
  readonly binding?: JudgeBinding;
}

/** What an agent's loop is built from. */
export interface AgentLoopDeps {
  readonly agent: AgentDefinition;
  readonly bundle: string;
  /** The execution's budgets (#261), checked before every model call. */
  readonly budgets: BudgetCheck;
  /** Set only with a pause seam: which calls wait for a decision, and how it is asked. */
  readonly approval?: ToolCallApproval | undefined;
  readonly judges: JudgePoints;
  /** The PII policies at the agent's model (#120): masked into it, revealed out of it. */
  readonly pii?: PiiPolicySet;
  /** Its input guardrails (#120): on what its model reads of the visit, masked, before the first call. */
  readonly guardrails?: readonly RuntimeGuardrail[];
  /** Its tool interceptors (#384): the chain of its calls to each tool, outer first. */
  readonly interceptors?: ToolInterceptorChains;
  readonly observer?: ExecutionObserverManager;
}

/** One tool call of a move, with its id (assigned by the loop when the model gives none). */
export interface ToolCallRequest {
  readonly callId: string;
  readonly tool: string;
  readonly args: Record<string, unknown>;
}

/** The tool calls of a move, in the model's order. */
export const callsOf = (move: AIMessage | null): ToolCallRequest[] =>
  (move?.tool_calls ?? []).map((call) => ({
    callId: call.id ?? "",
    tool: call.name,
    args: call.args,
  }));

/**
 * A tool call of a move whose arguments are no JSON (the model's `invalid_tool_calls`: a truncated
 * call, #395): it never runs — the model reads why and tries again.
 */
export interface InvalidToolCallRequest {
  readonly callId: string;
  readonly tool: string;
  /** The arguments as the model sent them: unparsed text. */
  readonly args: string;
  /** Why they could not be read. */
  readonly problem: string;
}

/** The calls of a move whose arguments are no JSON, in the model's order. */
export const invalidCallsOf = (move: AIMessage | null): InvalidToolCallRequest[] =>
  (move?.invalid_tool_calls ?? []).map((call) => ({
    callId: call.id ?? "",
    tool: call.name ?? "",
    args: call.args ?? "",
    problem: call.error ?? UNREADABLE_ARGUMENTS,
  }));

export const toolNamed = (agent: AgentDefinition, name: string): AnyTool | undefined =>
  agent.tools.find((tool) => tool.name === name);

/** Whether a call — read or not — is to one of the agent's answer tools. */
export const isAnswerCall = (
  agent: AgentDefinition,
  call: Pick<ToolCallRequest, "tool">,
): boolean => agent.answerTools.tools.some((tool) => tool.name === call.tool);
