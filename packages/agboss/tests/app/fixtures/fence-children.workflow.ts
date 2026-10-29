import { WorkflowStartTextDto } from "../../../src/dto/index.js";
import {
  Action,
  Budget,
  BudgetScope,
  ChildPlacement,
  EmptyEnvironment,
  ExecutionContext,
  Workflow,
  WorkflowFinish,
  WorkflowStart,
  type BudgetHandler,
  type Produced,
} from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { usd, type Usd } from "../../../src/units/index.js";
import { TEST_BUDGETS } from "../../flow/fixtures/budgets.js";
import { start } from "../../helpers/flow.js";
import { RecoveryLog } from "../../infrastructure/fixtures/recovery.workflow.js";
import { fenceSeenOf, ReceiptDto, type FenceSeen } from "./fence.workflow.js";

/**
 * #471 AC1 — which lease a step fences with: a root and its `ParentInstance` children share the
 * root's (`(tenantId, rootExecutionId)`), a `ChildPlacement.AnyInstance` child holds its own
 * (`(tenantId, childExecutionId)`); an ancestor's fence (`parent.fence`, `root.fence`) is never
 * read, and a budget's `maxSpend()` — read before the first pass — has none.
 */

/** What the steps and the budget saw: each step's fence, and why a fence could not be read. */
export const scopes = {
  fences: new Map<string, FenceSeen>(),
  refusals: new Map<string, unknown>(),
};

export function resetScopes(): void {
  scopes.fences.clear();
  scopes.refusals.clear();
}

/** What reading `read` threw (`undefined` when it read). */
function refusalOf(read: () => unknown): unknown {
  try {
    read();
    return undefined;
  } catch (error) {
    return error;
  }
}

/** Records the step's fence under `at`, and what its ancestors' fences threw. */
function recordScope(executionContext: ExecutionContext, at: string): ReceiptDto {
  const { fence, step, parent } = executionContext;
  scopes.fences.set(at, fenceSeenOf(fence, step.idempotencyKey));
  if (parent !== undefined) {
    scopes.refusals.set(
      `${at}.parent`,
      refusalOf(() => parent.fence.token),
    );
    scopes.refusals.set(
      `${at}.root`,
      refusalOf(() => executionContext.root.fence.token),
    );
  }
  return { text: at };
}

@Action({
  name: "scope-root-action",
  description: "Records the root's fence",
  input: { message: WorkflowStartTextDto },
  output: WorkflowStartTextDto,
  deps: [ExecutionContext],
})
export class ScopeRootAction {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(input: {
    readonly message: Produced<WorkflowStartTextDto, unknown>;
  }): Promise<WorkflowStartTextDto> {
    recordScope(this.executionContext, `root ${input.message.value.text}`);
    return Promise.resolve({ text: input.message.value.text });
  }
}

@Action({
  name: "scope-near-child-action",
  description: "Records a ParentInstance child's fence",
  input: { message: WorkflowStartTextDto },
  output: ReceiptDto,
  deps: [ExecutionContext],
})
export class ScopeNearChildAction {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(): Promise<ReceiptDto> {
    return Promise.resolve(recordScope(this.executionContext, "near child"));
  }
}

@Action({
  name: "scope-far-child-action",
  description: "Records an AnyInstance child's fence",
  input: { message: WorkflowStartTextDto },
  output: ReceiptDto,
  deps: [ExecutionContext],
})
export class ScopeFarChildAction {
  constructor(private readonly executionContext: ExecutionContext) {}

  execute(): Promise<ReceiptDto> {
    return Promise.resolve(recordScope(this.executionContext, "far child"));
  }
}

@WorkflowStart({
  name: "near-child-workflow-start",
  description: "A child",
  input: WorkflowStartTextDto,
})
export class NearChildWorkflowStart {}

@WorkflowStart({
  name: "far-child-workflow-start",
  description: "A child",
  input: WorkflowStartTextDto,
})
export class FarChildWorkflowStart {}

@WorkflowFinish({ name: "near-child-workflow-finish", description: "Done", output: ReceiptDto })
export class NearChildWorkflowFinish {}

@WorkflowFinish({ name: "far-child-workflow-finish", description: "Done", output: ReceiptDto })
export class FarChildWorkflowFinish {}

@Workflow({
  name: "near-child-workflow",
  version: "1.0.0",
  flow: [
    start(NearChildWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAction(ScopeNearChildAction)
      .returns(ReceiptDto)
      .toFinish(NearChildWorkflowFinish),
  ],
})
export class NearChildWorkflow {}

@Workflow({
  name: "far-child-workflow",
  version: "1.0.0",
  flow: [
    start(FarChildWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAction(ScopeFarChildAction)
      .returns(ReceiptDto)
      .toFinish(FarChildWorkflowFinish),
  ],
})
export class FarChildWorkflow {}

@WorkflowStart({
  name: "near-parent-workflow-start",
  description: "A parent",
  input: WorkflowStartTextDto,
})
export class NearParentWorkflowStart {}

@WorkflowStart({
  name: "far-parent-workflow-start",
  description: "A parent",
  input: WorkflowStartTextDto,
})
export class FarParentWorkflowStart {}

@WorkflowFinish({ name: "near-parent-workflow-finish", description: "Done", output: ReceiptDto })
export class NearParentWorkflowFinish {}

@WorkflowFinish({ name: "far-parent-workflow-finish", description: "Done", output: ReceiptDto })
export class FarParentWorkflowFinish {}

@Workflow({
  name: "near-parent-workflow",
  version: "1.0.0",
  flow: [
    start(NearParentWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toAction(ScopeRootAction)
      .returns(WorkflowStartTextDto)
      .toWorkflow(NearChildWorkflow)
      .returns(ReceiptDto)
      .toFinish(NearParentWorkflowFinish),
  ],
})
export class NearParentWorkflow {}

@Workflow({
  name: "far-parent-workflow",
  version: "1.0.0",
  flow: [
    start(FarParentWorkflowStart)
      .returns(WorkflowStartTextDto)
      .toWorkflow(FarChildWorkflow, { placement: ChildPlacement.AnyInstance })
      .returns(ReceiptDto)
      .toFinish(FarParentWorkflowFinish),
  ],
})
export class FarParentWorkflow {}

/** The near parent's budget: its `maxSpend()` reads the fence, before the first pass. */
@Budget({
  name: "fence-probe-execution-budget",
  scope: BudgetScope.Execution,
  workflow: NearParentWorkflow,
  deps: [ExecutionContext],
})
export class FenceProbeBudget implements BudgetHandler {
  constructor(private readonly executionContext: ExecutionContext) {}

  maxSpend(): Usd {
    scopes.refusals.set(
      "maxSpend",
      refusalOf(() => this.executionContext.fence.token),
    );
    return usd(1);
  }
}

@Application({
  name: "fence-children-application",
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [NearParentWorkflow, FarParentWorkflow],
  observers: [RecoveryLog],
  budgets: [...TEST_BUDGETS, FenceProbeBudget],
})
export class FenceChildrenApplication {}
