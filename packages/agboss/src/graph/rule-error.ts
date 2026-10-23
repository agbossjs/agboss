/** Codes of the assembly rules — stable, for people and for tests. */
export type RuleCode =
  | "graph.not-a-node"
  | "graph.choose-from-non-router"
  | "graph.duplicate-node-name"
  | "graph.no-workflow-start"
  | "graph.unreachable-node"
  | "graph.dead-end"
  | "graph.next-after-workflow-finish"
  | "router.routes-mismatch"
  | "router.no-prompt"
  // the flow v2 rules (#272 PR 2, #270), reported by `src/flow/analyse`
  | "graph.wrong-kind"
  | "graph.cycle-without-max-visits"
  | "flow.shared-node-inline"
  | "flow.single-entry-own-path"
  | "flow.continuation-twice"
  | "flow.switch-not-exhaustive"
  | "flow.switch-unknown-case"
  | "flow.duplicate-error-handler"
  | "flow.returns-mismatch"
  | "flow.path-too-deep"
  | "flow.analysis-too-large"
  | "flow.unused-output"
  | "flow.ambiguous-field"
  | "flow.text-agent-target"
  | "input.missing-on-path"
  | "input.never-produced"
  | "input.several-on-path"
  | "input.history-limit"
  // outdating (#271 PR 1), reported by `src/flow/analyse`
  | "input.outdated-on-path"
  | "io.ambiguous-cycle"
  | "io.ambiguous-about"
  | "io.about-on-start"
  | "router.duplicate-route"
  | "router.empty-input"
  | "router.no-model"
  | "router.policy-with-choose-one"
  | "router.all-routes-always"
  // parallel launches (#273 PR 1), reported by `src/flow/analyse`
  | "router.spawn-required"
  | "router.prompt-on-always"
  | "launch.join-required"
  | "launch.max-items-required"
  | "launch.max-items-without-list"
  | "launch.item-not-read"
  | "launch.branch-continued"
  | "launch.branch-outdates-sibling"
  // quorums (#279 PR 1), reported by `src/flow/analyse`
  | "flow.quorum-impossible"
  | "flow.quorum-return-not-optional"
  | "arbiter.not-an-arbiter"
  | "arbiter.unhandled-agent"
  | "arbiter.unknown-agent"
  | "arbiter.duplicate-agent"
  | "arbiter.answer-method-on-model"
  | "arbiter.method-name"
  // child workflows (#263 PR 1), reported by `src/flow/analyse`
  | "graph.no-matching-start"
  | "graph.ambiguous-start"
  | "graph.child-without-failure-finish"
  | "graph.limit-handler-uses-model"
  // recursion (#264 PR 1), reported by `src/flow/analyse`
  | "graph.recursion-without-depth"
  | "graph.recursion-without-exit"
  | "graph.mutual-recursion"
  // the tree's concurrency cap (#264 PR 2), reported by `src/flow/analyse`
  | "limits.max-concurrent-executions-invalid"
  | "limits.child-concurrency-above-parent"
  // declared action compensation (#339 PR 1), reported by `src/flow/analyse`
  | "action.compensator-not-an-action"
  | "action.committer-not-an-action"
  | "action.self-compensation"
  | "action.compensator-compensates"
  | "action.invalid-compensator-input"
  | "action.committer-without-compensator"
  | "flow.uncompensated-action"
  | "flow.uncommitted-action"
  | "flow.compensation-out-of-order"
  | "flow.committer-unreachable"
  // the instance's cap on steps (#332), reported at the application's assembly
  | "limits.max-concurrent-steps-invalid"
  | "name.kind-suffix"
  | "dto.name"
  | "dto.duplicate-name"
  | "tool.name-too-long"
  | "tool.name-invalid"
  // a bound on tool results (#336), reported at assembly by `src/components/assemble-tools.ts`
  | "tools.max-result-size-invalid"
  | "limits.max-steps-too-low"
  | "limits.branch-exceeds-max-steps"
  | "limits.max-steps-unused"
  | "agent.dynamic-options"
  | "model.no-tool-calling"
  // type generation (#272 PR 3), reported by `src/flow/types`
  | "types.unexported-class"
  // the application (#261), reported at its assembly
  | "application.no-workflows"
  | "application.not-a-workflow"
  | "application.duplicate-workflow"
  | "application.ambiguous-start"
  | "budget.not-a-budget"
  // health checks (#300): every listed class a @HealthCheck, one name each
  | "health.not-a-health-check"
  | "health.duplicate-name"
  // budgets at run time (#261 PR 5): every workflow, every tenant and the application capped
  | "budget.execution-budget-required"
  | "budget.duplicate-execution-budget"
  | "budget.duplicate-default-execution-budget"
  | "budget.tenant-budget-required"
  | "budget.application-budget-required"
  | "di.infrastructure-in-workflow"
  // environments and defaults (#261 PR 4), reported at the application's assembly
  | "environment.contract-value"
  | "environment.missing-field"
  // guardrails (#120 PR 2), reported at each workflow's assembly
  | "guardrail.no-model"
  | "guardrail.not-a-guardrail"
  | "guardrail.exclude-not-inherited"
  | "guardrail.missing-refusal"
  | "guardrail.refusal-twice"
  | "guardrail.no-prompt"
  | "guardrail.threshold-invalid"
  | "guardrail.output-on-router"
  | "guardrail.no-model-call"
  // code guardrails (#383): a DecidedBy.Code guardrail's class has its check(text)
  | "guardrail.missing-handler"
  // tool interceptors (#384), reported at each workflow's assembly
  | "tool-interceptor.not-an-interceptor"
  | "tool-interceptor.exclude-not-inherited"
  | "tool-interceptor.missing-handler"
  // compaction (#120 PR 3), reported at each workflow's assembly
  | "compaction.not-a-compaction"
  | "compaction.invalid-setting"
  | "compaction.decision-model"
  | "compaction.uncompacted-turns-invalid"
  // a custom compaction (#382) without its compact(input) method
  | "compaction.missing-handler"
  // model providers (#266 PR 1): every model of the application resolves to one provider
  | "model.unserved"
  | "model.ambiguous-provider"
  // contexts (#261 PR 3), reported at the application's assembly
  | "context.prompt-unused"
  // channels (#267 PR 1): roles found from the graph, implementations in the application's providers
  | "channel.wrong-tool"
  | "channel.shared-interpreter"
  // reply interpreters (#267 PR 3), reported at each workflow's assembly
  | "reply-interpreter.not-an-interpreter"
  | "reply-interpreter.decision-model"
  | "reply-interpreter.no-interpret-method"
  | "di.missing-implementation"
  | "di.ambiguous-implementation"
  // PII policies (#120 PR 1), reported at each workflow's assembly
  | "pii.not-a-policy"
  | "pii.exclude-not-inherited"
  | "pii.conflicting-rules"
  | "pii.missing-refusal"
  | "pii.unused-refusal"
  | "pii.kind-needs-model"
  // typed judges (#262 PR 4, S115): every class an agent answers with is one its judges judge
  | "judge.wrong-reply"
  // eval suites (#396 PR 1), reported when a suite is assembled on its application
  | "eval.unknown-start"
  | "eval.duplicate-case"
  | "eval.judge-wrong-reply";

/** One broken rule: its code, what is wrong, and the nodes (classes) involved. */
export interface RuleViolation {
  readonly code: RuleCode;
  readonly message: string;
  readonly nodes: readonly string[];
}

export const violation = (
  code: RuleCode,
  message: string,
  nodes: readonly string[],
): RuleViolation => ({ code, message, nodes });

/** The flow breaks assembly rules — every violation found, reported at once, before any model call. */
export class GraphRuleError extends Error {
  override name = "GraphRuleError";
  readonly violations: readonly RuleViolation[];

  constructor(violations: readonly RuleViolation[]) {
    const lines = violations.map((item) => `  - [${item.code}] ${item.message}`);
    super(`The workflow's flow breaks ${String(violations.length)} rule(s):\n${lines.join("\n")}`);
    this.violations = violations;
  }
}

/** Throws when anything was found. */
export function throwIfViolated(violations: readonly RuleViolation[]): void {
  if (violations.length > 0) throw new GraphRuleError(violations);
}
