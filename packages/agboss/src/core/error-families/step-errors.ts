import { defineFamily, type FamilyConstructor, type PaidErrorVariant } from "./family.js";
import type { ModelFileLimit as FileLimit } from "../../files/model-files.js";
import type { WorkflowRecord } from "../../flow/context/execution-context.js";
import type { JudgeRejection, StepCoordinates } from "../../graph/errors.js";
import type { Milliseconds } from "../../units/index.js";

/** The kinds of `StepError`: `switch (error.kind)` is exhaustive. */
export enum StepErrorKind {
  Agent = "agent",
  AgentAnswerInvalid = "agent-answer-invalid",
  QualityGate = "quality-gate",
  Action = "action",
  ActionOutcomeUnknown = "action-outcome-unknown",
  Router = "router",
  RouterDecision = "router-decision",
  ExternalTask = "external-task",
  PauseExpired = "pause-expired",
  Arbiter = "arbiter",
  QuorumNotReached = "quorum-not-reached",
  Child = "child",
  Guardrail = "guardrail",
  ToolBlocked = "tool-blocked",
  ToolTimeout = "tool-timeout",
  RerankFailed = "rerank-failed",
  Memory = "memory",
  ModelFileLimit = "model-file-limit",
  FileMaskingFailed = "file-masking-failed",
}

/** A step of the run failed (#273 S22): which step (`component`, `nodeId`, `visitNumber`, `itemIndex`), what it spent (`usage`, `spend`) and why. A limit, a cancellation or a lost lease is never a step's failure: `LimitError` and `ExecutionError` are their own families. */
export type StepError =
  | StepError.Agent
  | StepError.AgentAnswerInvalid
  | StepError.QualityGate
  | StepError.Action
  | StepError.ActionOutcomeUnknown
  | StepError.Router
  | StepError.RouterDecision
  | StepError.ExternalTask
  | StepError.PauseExpired
  | StepError.Arbiter
  | StepError.QuorumNotReached
  | StepError.Child
  | StepError.Guardrail
  | StepError.ToolBlocked
  | StepError.ToolTimeout
  | StepError.RerankFailed
  | StepError.Memory
  | StepError.ModelFileLimit
  | StepError.FileMaskingFailed;

/** The variants of `StepError`, each with the facts it carries. */
export declare namespace StepError {
  /** An agent's loop failed. */
  export type Agent = PaidErrorVariant<StepErrorKind.Agent, "step.agent"> &
    StepCoordinates & { readonly agent: string };
  /** An agent's answer is not what its output declares. */
  export type AgentAnswerInvalid = PaidErrorVariant<
    StepErrorKind.AgentAnswerInvalid,
    "step.agent.invalid-answer"
  > &
    StepCoordinates & { readonly agent: string; readonly attempts: number };
  /** An agent's reply still failed its judges after its retries. */
  export type QualityGate = PaidErrorVariant<StepErrorKind.QualityGate, "step.agent.quality-gate"> &
    StepCoordinates & {
      readonly agent: string;
      readonly rejections: readonly JudgeRejection[];
      readonly retries: number;
    };
  /** An action failed. */
  export type Action = PaidErrorVariant<StepErrorKind.Action, "step.action"> &
    StepCoordinates & { readonly action: string };
  /**
   * An action ran past its timeout: it may still finish, so whether its effect happened is UNKNOWN.
   * Never retried or undone by the framework — `action` names the step, for the flow's `.onError` or
   * an operator to settle. A retry from `.onError` is safe for what went through `Idempotency`.
   */
  export type ActionOutcomeUnknown = PaidErrorVariant<
    StepErrorKind.ActionOutcomeUnknown,
    "step.action.outcome-unknown"
  > &
    StepCoordinates & { readonly action: string; readonly timeout: Milliseconds };
  /** A router's model call or its `route()` failed. */
  export type Router = PaidErrorVariant<StepErrorKind.Router, "step.router"> &
    StepCoordinates & { readonly router: string };
  /** A router answered outside its routes. */
  export type RouterDecision = PaidErrorVariant<
    StepErrorKind.RouterDecision,
    "step.router.invalid-decision"
  > &
    StepCoordinates & { readonly router: string; readonly reason: string };
  /** An external task failed. */
  export type ExternalTask = PaidErrorVariant<StepErrorKind.ExternalTask, "step.external-task"> &
    StepCoordinates & { readonly externalTask: string };
  /** A pause's deadline passed. */
  export type PauseExpired = PaidErrorVariant<StepErrorKind.PauseExpired, "step.pause-expired"> &
    StepCoordinates & { readonly step: string };
  /** An arbiter failed. */
  export type Arbiter = PaidErrorVariant<StepErrorKind.Arbiter, "step.arbiter"> &
    StepCoordinates & { readonly arbiter: string };
  /** A quorum cannot be reached. */
  export type QuorumNotReached = PaidErrorVariant<StepErrorKind.QuorumNotReached, "step.quorum"> &
    StepCoordinates & {
      readonly launch: string;
      readonly min?: number | undefined;
      readonly counted: number;
      readonly reason: string;
      readonly expired: readonly string[];
    };
  /** A child workflow failed. */
  export type Child = PaidErrorVariant<StepErrorKind.Child, "step.child"> &
    StepCoordinates & { readonly childExecutionId: string; readonly workflow: WorkflowRecord };
  /** A guardrail's check failed. */
  export type Guardrail = PaidErrorVariant<StepErrorKind.Guardrail, "step.guardrail"> &
    StepCoordinates & { readonly guardrail: string };
  /** A tool call was blocked by an interceptor. */
  export type ToolBlocked = PaidErrorVariant<StepErrorKind.ToolBlocked, "step.tool-blocked"> &
    StepCoordinates & {
      readonly agent: string;
      readonly tool: string;
      readonly interceptor: string;
      readonly reason: string;
    };
  /** A tool ran past its timeout. */
  export type ToolTimeout = PaidErrorVariant<StepErrorKind.ToolTimeout, "step.tool-timeout"> &
    StepCoordinates & { readonly tool: string; readonly timeout: Milliseconds };
  /** A reranker failed. */
  export type RerankFailed = PaidErrorVariant<StepErrorKind.RerankFailed, "step.rerank-failed"> &
    StepCoordinates & { readonly rag: string; readonly reranker: string };
  /** A memory's compaction failed. */
  export type Memory = PaidErrorVariant<StepErrorKind.Memory, "step.memory"> &
    StepCoordinates & { readonly memory: string };
  /** A file the model was given is over a limit. */
  export type ModelFileLimit = PaidErrorVariant<
    StepErrorKind.ModelFileLimit,
    "step.model-file-limit"
  > &
    StepCoordinates & {
      readonly agent: string;
      readonly limit: FileLimit;
      readonly actual: number | string;
      readonly allowed: number | string;
    };
  /** A file could not be masked before the model. */
  export type FileMaskingFailed = PaidErrorVariant<
    StepErrorKind.FileMaskingFailed,
    "step.file-redaction-failed"
  > &
    StepCoordinates & { readonly agent: string; readonly reason: string };
}

/** `StepError`: the family's constructor and its variants'. */
export const StepError: FamilyConstructor<
  StepError,
  {
    Agent: StepError.Agent;
    AgentAnswerInvalid: StepError.AgentAnswerInvalid;
    QualityGate: StepError.QualityGate;
    Action: StepError.Action;
    ActionOutcomeUnknown: StepError.ActionOutcomeUnknown;
    Router: StepError.Router;
    RouterDecision: StepError.RouterDecision;
    ExternalTask: StepError.ExternalTask;
    PauseExpired: StepError.PauseExpired;
    Arbiter: StepError.Arbiter;
    QuorumNotReached: StepError.QuorumNotReached;
    Child: StepError.Child;
    Guardrail: StepError.Guardrail;
    ToolBlocked: StepError.ToolBlocked;
    ToolTimeout: StepError.ToolTimeout;
    RerankFailed: StepError.RerankFailed;
    Memory: StepError.Memory;
    ModelFileLimit: StepError.ModelFileLimit;
    FileMaskingFailed: StepError.FileMaskingFailed;
  }
> = defineFamily({
  name: "StepError",
  code: "step",
  kinds: StepErrorKind,
  paid: true,
  variants: {
    Agent: ["an agent's loop failed"],
    AgentAnswerInvalid: [
      "an agent's answer is not what its output declares",
      "step.agent.invalid-answer",
    ],
    QualityGate: [
      "an agent's reply still failed its judges after its retries",
      "step.agent.quality-gate",
    ],
    Action: ["an action failed"],
    ActionOutcomeUnknown: [
      "an action ran past its timeout: its effect may have happened",
      "step.action.outcome-unknown",
    ],
    Router: ["a router's model call or its `route()` failed"],
    RouterDecision: ["a router answered outside its routes", "step.router.invalid-decision"],
    ExternalTask: ["an external task failed"],
    PauseExpired: ["a pause's deadline passed"],
    Arbiter: ["an arbiter failed"],
    QuorumNotReached: ["a quorum cannot be reached", "step.quorum"],
    Child: ["a child workflow failed"],
    Guardrail: ["a guardrail's check failed"],
    ToolBlocked: ["a tool call was blocked by an interceptor"],
    ToolTimeout: ["a tool ran past its timeout"],
    RerankFailed: ["a reranker failed"],
    Memory: ["a memory's compaction failed"],
    ModelFileLimit: ["a file the model was given is over a limit"],
    FileMaskingFailed: [
      "a file could not be masked before the model",
      "step.file-redaction-failed",
    ],
  },
});
