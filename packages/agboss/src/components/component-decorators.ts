// The decorators of a component the container creates (#402): one instance per application
// instance, so it keeps no state — what `agboss/no-component-state` (`agboss/eslint`) checks. The
// one list of them, owned by the framework: the rule reads it, and a test
// (tests/lint/component-decorators.test.ts) fails when a class decorator exported by a public entry
// is neither listed here nor named there as not a component. Plain data, no imports: the lint entry
// loads it without loading the framework.

/** The names of the decorators that make a class a component the container creates once. */
export const COMPONENT_DECORATORS = [
  // `agboss`
  "Injectable",
  "Tool",
  "Action",
  "Router",
  "WorkflowFinish",
  "Channel",
  "ReplyInterpreter",
  "InputGuardrail",
  "OutputGuardrail",
  "PiiPolicy",
  "Judge",
  "Arbiter",
  "Compaction",
  "Budget",
  "HealthCheck",
  // `agboss/models`
  "ModelProvider",
  // `agboss/mcp`
  "McpServer",
  "McpTool",
  // `agboss/rag`
  "Rag",
  // `agboss/a2a`
  "A2AAgent",
] as const;

/** One of `COMPONENT_DECORATORS`. */
export type ComponentDecoratorName = (typeof COMPONENT_DECORATORS)[number];
