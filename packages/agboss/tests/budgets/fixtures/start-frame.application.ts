import { Budget, BudgetScope, EmptyEnvironment, ExecutionContext } from "../../../src/index.js";
import type { BudgetHandler } from "../../../src/index.js";
import { Application } from "../../../src/application/application.js";
import { usd, type Usd } from "../../../src/units/index.js";
import {
  BriefWorkflow,
  ShopApplicationDailyBudget,
  ShopTenantContext,
  ShopTenantMonthlyBudget,
} from "./budgets.application.js";
import { TestModelProvider } from "../../../src/testing/test-model-provider.js";

/**
 * #1356: an execution budget that reads the frame of the start in which its `maxSpend()` runs (the
 * `ExecutionContext`, #261 PR 5): what an execution is before its first step.
 */

/** What one `maxSpend()` read of the execution's context. */
export interface FrameRead {
  readonly executionId: string;
  readonly ownerId: string | undefined;
  readonly tenantId: string;
  /** The project's own tenant context, with its own field (#261). */
  readonly tenantOwn: boolean;
  readonly tenantDailyBudgetUsd: unknown;
  readonly aborted: boolean;
  readonly workflow: { name: string; version: string; startedVersion: string; configHash: string };
  readonly workflowType: unknown;
  readonly step: {
    readonly nodeId: string;
    readonly visitNumber: number;
    readonly idempotencyKey: string;
    readonly callId: string | undefined;
    readonly itemIndex: number | undefined;
    readonly copyNumber: number;
    readonly toolLoopIteration: number | undefined;
    readonly validationAttempts: number;
    readonly componentName: string;
    readonly componentType: unknown;
  };
  /** The thread as `maxSpend()` reads it, or what it failed with. */
  readonly thread: string;
}

export const frameReads: FrameRead[] = [];

@Budget({
  name: "frame-reading-budget",
  scope: BudgetScope.Execution,
  workflow: BriefWorkflow,
  deps: [ExecutionContext],
})
export class FrameReadingBudget implements BudgetHandler {
  constructor(private readonly executionContext: ExecutionContext) {}

  maxSpend(): Usd {
    const { executionId, ownerId, tenant, signal, workflow, step } = this.executionContext;
    frameReads.push({
      executionId,
      ownerId,
      tenantId: tenant.tenantId,
      tenantOwn: tenant instanceof ShopTenantContext,
      tenantDailyBudgetUsd: Reflect.get(tenant, "dailyBudgetUsd"),
      aborted: signal.aborted,
      workflow: {
        name: workflow.name,
        version: workflow.version,
        startedVersion: workflow.startedVersion,
        configHash: workflow.configHash,
      },
      workflowType: workflow.type,
      step: {
        nodeId: step.nodeId,
        visitNumber: step.visitNumber,
        idempotencyKey: step.idempotencyKey,
        callId: step.callId,
        itemIndex: step.itemIndex,
        copyNumber: step.copyNumber,
        toolLoopIteration: step.toolLoopIteration,
        validationAttempts: step.validationAttempts,
        componentName: step.component.name,
        componentType: step.component.type,
      },
      thread: threadOf(this.executionContext),
    });
    return usd(1);
  }
}

const threadOf = (context: ExecutionContext): string => {
  try {
    return context.threadId;
  } catch (error) {
    return error instanceof Error ? error.message : "failed";
  }
};

@Application({
  name: "frame-application",
  modelProvider: TestModelProvider,
  version: "1.0.0",
  environment: EmptyEnvironment,
  workflows: [BriefWorkflow],
  tenantContext: ShopTenantContext,
  budgets: [ShopApplicationDailyBudget, ShopTenantMonthlyBudget, FrameReadingBudget],
})
export class FrameApplication {}
