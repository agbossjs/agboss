import { defineFamily, type ErrorVariant, type FamilyConstructor } from "./family.js";

/** The kinds of `ConfigError`: `switch (error.kind)` is exhaustive. */
export enum ConfigErrorKind {
  GraphRules = "graph-rules",
  FlowSyntax = "flow-syntax",
  NotAWorkflowStart = "not-a-workflow-start",
  WorkingCalendar = "working-calendar",
  Component = "component",
  Prompt = "prompt",
  NoDefaultRouter = "no-default-router",
  Environment = "environment",
  Profile = "profile",
  ModelProvider = "model-provider",
  ModelSettings = "model-settings",
  ModelKind = "model-kind",
  Dto = "dto",
  Unit = "unit",
  PromptCaching = "prompt-caching",
  RateLimitPolicy = "rate-limit-policy",
  CircuitBreakerPolicy = "circuit-breaker-policy",
  Reasoning = "reasoning",
  RetryPolicy = "retry-policy",
  EvalCase = "eval-case",
  RagIndex = "rag-index",
  WorkflowLoad = "workflow-load",
  ApplicationLoad = "application-load",
  Tool = "tool",
  Option = "option",
}

/** The application's declaration is wrong: a rule of the graph, a component, a prompt, an environment, a profile, a model's settings. Found at assembly or load, before any model call. */
export type ConfigError =
  | ConfigError.GraphRules
  | ConfigError.FlowSyntax
  | ConfigError.NotAWorkflowStart
  | ConfigError.WorkingCalendar
  | ConfigError.Component
  | ConfigError.Prompt
  | ConfigError.NoDefaultRouter
  | ConfigError.Environment
  | ConfigError.Profile
  | ConfigError.ModelProvider
  | ConfigError.ModelSettings
  | ConfigError.ModelKind
  | ConfigError.Dto
  | ConfigError.Unit
  | ConfigError.PromptCaching
  | ConfigError.RateLimitPolicy
  | ConfigError.CircuitBreakerPolicy
  | ConfigError.Reasoning
  | ConfigError.RetryPolicy
  | ConfigError.EvalCase
  | ConfigError.RagIndex
  | ConfigError.WorkflowLoad
  | ConfigError.ApplicationLoad
  | ConfigError.Tool
  | ConfigError.Option;

/** The variants of `ConfigError`, each with the facts it carries. */
export declare namespace ConfigError {
  /** The workflow graph breaks assembly rules. */
  export type GraphRules = ErrorVariant<ConfigErrorKind.GraphRules, "config.graph-rules">;
  /** A flow is written wrongly. */
  export type FlowSyntax = ErrorVariant<ConfigErrorKind.FlowSyntax, "config.flow-syntax">;
  /** The class is not a workflow start. */
  export type NotAWorkflowStart = ErrorVariant<
    ConfigErrorKind.NotAWorkflowStart,
    "config.not-a-workflow-start"
  >;
  /** A working calendar is not valid. */
  export type WorkingCalendar = ErrorVariant<
    ConfigErrorKind.WorkingCalendar,
    "config.working-calendar"
  >;
  /** A component is not valid. */
  export type Component = ErrorVariant<ConfigErrorKind.Component, "config.component">;
  /** A prompt is not valid. */
  export type Prompt = ErrorVariant<ConfigErrorKind.Prompt, "config.prompt">;
  /** The application has no default router. */
  export type NoDefaultRouter = ErrorVariant<
    ConfigErrorKind.NoDefaultRouter,
    "config.no-default-router"
  >;
  /** The environment is not valid. */
  export type Environment = ErrorVariant<ConfigErrorKind.Environment, "config.environment">;
  /** A profile is not valid. */
  export type Profile = ErrorVariant<ConfigErrorKind.Profile, "config.profile">;
  /** A model provider is not valid. */
  export type ModelProvider = ErrorVariant<ConfigErrorKind.ModelProvider, "config.model-provider">;
  /** A model's settings do not fit it. */
  export type ModelSettings = ErrorVariant<ConfigErrorKind.ModelSettings, "config.model-settings">;
  /** A model is used for what it cannot do. */
  export type ModelKind = ErrorVariant<ConfigErrorKind.ModelKind, "config.model-kind">;
  /** A DTO class is not valid. */
  export type Dto = ErrorVariant<ConfigErrorKind.Dto, "config.dto">;
  /** A unit value is not valid. */
  export type Unit = ErrorVariant<ConfigErrorKind.Unit, "config.unit">;
  /** The prompt-caching policy is not valid. */
  export type PromptCaching = ErrorVariant<ConfigErrorKind.PromptCaching, "config.prompt-caching">;
  /** The circuit-breaker policy is not valid. */
  export type CircuitBreakerPolicy = ErrorVariant<
    ConfigErrorKind.CircuitBreakerPolicy,
    "config.circuit-breaker-policy"
  >;
  /** The rate-limit policy is not valid. */
  export type RateLimitPolicy = ErrorVariant<
    ConfigErrorKind.RateLimitPolicy,
    "config.rate-limit-policy"
  >;
  /** The reasoning setting is not valid. */
  export type Reasoning = ErrorVariant<ConfigErrorKind.Reasoning, "config.reasoning">;
  /** The retry policy is not valid. */
  export type RetryPolicy = ErrorVariant<ConfigErrorKind.RetryPolicy, "config.retry-policy">;
  /** An eval case is not valid. */
  export type EvalCase = ErrorVariant<ConfigErrorKind.EvalCase, "config.eval-case">;
  /** The RAG index cannot be used. */
  export type RagIndex = ErrorVariant<ConfigErrorKind.RagIndex, "config.rag-index">;
  /** A workflow cannot be loaded. */
  export type WorkflowLoad = ErrorVariant<ConfigErrorKind.WorkflowLoad, "config.workflow-load">;
  /** The application cannot be loaded. */
  export type ApplicationLoad = ErrorVariant<
    ConfigErrorKind.ApplicationLoad,
    "config.application-load"
  >;
  /** A tool is not valid. */
  export type Tool = ErrorVariant<ConfigErrorKind.Tool, "config.tool">;
  /** An option is not valid. */
  export type Option = ErrorVariant<ConfigErrorKind.Option, "config.option">;
}

/** `ConfigError`: the family's constructor and its variants'. */
export const ConfigError: FamilyConstructor<
  ConfigError,
  {
    GraphRules: ConfigError.GraphRules;
    FlowSyntax: ConfigError.FlowSyntax;
    NotAWorkflowStart: ConfigError.NotAWorkflowStart;
    WorkingCalendar: ConfigError.WorkingCalendar;
    Component: ConfigError.Component;
    Prompt: ConfigError.Prompt;
    NoDefaultRouter: ConfigError.NoDefaultRouter;
    Environment: ConfigError.Environment;
    Profile: ConfigError.Profile;
    ModelProvider: ConfigError.ModelProvider;
    ModelSettings: ConfigError.ModelSettings;
    ModelKind: ConfigError.ModelKind;
    Dto: ConfigError.Dto;
    Unit: ConfigError.Unit;
    PromptCaching: ConfigError.PromptCaching;
    RateLimitPolicy: ConfigError.RateLimitPolicy;
    CircuitBreakerPolicy: ConfigError.CircuitBreakerPolicy;
    Reasoning: ConfigError.Reasoning;
    RetryPolicy: ConfigError.RetryPolicy;
    EvalCase: ConfigError.EvalCase;
    RagIndex: ConfigError.RagIndex;
    WorkflowLoad: ConfigError.WorkflowLoad;
    ApplicationLoad: ConfigError.ApplicationLoad;
    Tool: ConfigError.Tool;
    Option: ConfigError.Option;
  }
> = defineFamily({
  name: "ConfigError",
  code: "config",
  kinds: ConfigErrorKind,
  variants: {
    GraphRules: ["the workflow graph breaks assembly rules"],
    FlowSyntax: ["a flow is written wrongly"],
    NotAWorkflowStart: ["the class is not a workflow start"],
    WorkingCalendar: ["a working calendar is not valid"],
    Component: ["a component is not valid"],
    Prompt: ["a prompt is not valid"],
    NoDefaultRouter: ["the application has no default router"],
    Environment: ["the environment is not valid"],
    Profile: ["a profile is not valid"],
    ModelProvider: ["a model provider is not valid"],
    ModelSettings: ["a model's settings do not fit it"],
    ModelKind: ["a model is used for what it cannot do"],
    Dto: ["a DTO class is not valid"],
    Unit: ["a unit value is not valid"],
    PromptCaching: ["the prompt-caching policy is not valid"],
    RateLimitPolicy: ["the rate-limit policy is not valid"],
    CircuitBreakerPolicy: ["the circuit-breaker policy is not valid"],
    Reasoning: ["the reasoning setting is not valid"],
    RetryPolicy: ["the retry policy is not valid"],
    EvalCase: ["an eval case is not valid"],
    RagIndex: ["the RAG index cannot be used"],
    WorkflowLoad: ["a workflow cannot be loaded"],
    ApplicationLoad: ["the application cannot be loaded"],
    Tool: ["a tool is not valid"],
    Option: ["an option is not valid"],
  },
});

/** The kinds of `DecisionError`: `switch (error.kind)` is exhaustive. */
export enum DecisionErrorKind {
  InvalidRequest = "invalid-request",
  InvalidResponse = "invalid-response",
}

/** A decision call failed on the framework's side of the Decisions API: a request it would refuse, or an answer that is unknown or malformed. */
export type DecisionError = DecisionError.InvalidRequest | DecisionError.InvalidResponse;

/** The variants of `DecisionError`, each with the facts it carries. */
export declare namespace DecisionError {
  /** A decision request the Decisions API would refuse: too many questions, a bad image, no options. */
  export type InvalidRequest = ErrorVariant<
    DecisionErrorKind.InvalidRequest,
    "model.decision.invalid-request"
  >;
  /** A Decisions API answer that is unknown or malformed. */
  export type InvalidResponse = ErrorVariant<
    DecisionErrorKind.InvalidResponse,
    "model.decision.invalid-response"
  >;
}

/** `DecisionError`: the family's constructor and its variants'. */
export const DecisionError: FamilyConstructor<
  DecisionError,
  { InvalidRequest: DecisionError.InvalidRequest; InvalidResponse: DecisionError.InvalidResponse }
> = defineFamily({
  name: "DecisionError",
  code: "model.decision",
  kinds: DecisionErrorKind,
  variants: {
    InvalidRequest: [
      "a decision request the Decisions API would refuse: too many questions, a bad image, no options",
    ],
    InvalidResponse: ["a Decisions API answer that is unknown or malformed"],
  },
});
