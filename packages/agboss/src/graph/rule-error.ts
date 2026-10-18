/** Codes of the assembly rules — stable, for people and for tests. */
export type RuleCode =
  | "graph.not-a-node"
  | "graph.two-next-steps"
  | "graph.choose-from-non-router"
  | "graph.router-not-last-in-chain"
  | "graph.cycle-without-router"
  | "graph.duplicate-node"
  | "graph.duplicate-node-name"
  | "graph.no-workflow-start"
  | "graph.unreachable-node"
  | "graph.dead-end"
  | "graph.next-after-workflow-finish"
  | "batch.invalid-batch-size"
  | "batch.invalid-concurrency-limit"
  | "batch.strategy-not-decorated"
  | "router.routes-mismatch"
  | "router.self-without-agent-before"
  | "router.no-prompt"
  | "router.empty-route-text"
  | "router.unbounded-cycle"
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
  | "name.kind-suffix"
  | "dto.name"
  | "dto.duplicate-name"
  | "tool.name-too-long"
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
  | "di.infrastructure-in-workflow"
  // environments and defaults (#261 PR 4), reported at the application's assembly
  | "environment.contract-value"
  | "environment.missing-field"
  | "guardrail.no-model"
  // model providers (#266 PR 1): every model of the application resolves to one provider
  | "model.unserved"
  | "model.ambiguous-provider";

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
