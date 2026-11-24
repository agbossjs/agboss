// The decorators of a component the container creates (#402): one instance per application
// instance, so it keeps no state — what `agboss/no-component-state` (`@agboss/core/eslint`) checks. The
// one list of them, owned by the framework: the rule reads it, and a test
// (tests/lint/component-decorators.test.ts) fails when a class decorator exported by a public entry
// is neither listed here nor named there as not a component. Plain data, no imports: the lint entry
// loads it without loading the framework.

/** The names of the decorators that make a class a component the container creates once. */
export const COMPONENT_DECORATORS = [
  // `@agboss/core`
  "Injectable",
  "Tool",
  "Action",
  "Router",
  "Channel",
  "ReplyInterpreter",
  "ToolApproval",
  "ExternalTask",
  "ChannelSelector",
  "ChannelInterpreter",
  "ChannelListener",
  "HttpAuthenticator",
  "InputGuardrail",
  "OutputGuardrail",
  "ToolInterceptor",
  "PiiPolicy",
  "Judge",
  "Arbiter",
  "Memory",
  "Budget",
  "HealthCheck",
  "Observer",
  "PauseListener",
  "WorkingCalendar",
  // `@agboss/core` storage components (#1321): one place of rows each, the container creates them
  "DatabaseStorage",
  "ClusterStorage",
  "ObjectStorage",
  // `@agboss/core/models`
  "ModelProvider",
  // `@agboss/core/mcp`
  "McpServer",
  // `@agboss/core/rag`
  "Rag",
  "RagReranker",
  // `@agboss/core/a2a`
  "A2AAgent",
] as const;

/** One of `COMPONENT_DECORATORS`. */
export type ComponentDecoratorName = (typeof COMPONENT_DECORATORS)[number];
