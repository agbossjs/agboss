import type { Class } from "../components/injection.js";
import { componentOf } from "../components/metadata.js";
import {
  ExecutionContext,
  type StepDescriptor,
  type WorkflowClass,
  type WorkflowDescriptor,
} from "../flow/context/execution-context.js";
import {
  applicationContextOf,
  type ApplicationContext,
} from "../flow/context/application-context.js";
import {
  executionFieldsOf,
  tenantContextOf,
  tenantFieldsOf,
  type ContextValues,
  type ExecutionContextClass,
  type TenantContextClass,
  type TenantValues,
} from "../flow/context/context-values.js";
import { TenantContext } from "../flow/context/tenant-context.js";
import { NO_ENVIRONMENT_VALUES } from "../environments/resolve.js";
import type { Environment } from "../flow/generated-types.js";
import { idempotencyKeyOf } from "../flow/context/idempotency.js";
import { declarationOf } from "../flow/decorators/declaration.js";

/** The step of a `testExecutionContext`: what is not given takes its default. */
export interface TestStepOptions {
  /** The component the step runs (its `name` from its decorator); default: a step `test-step`. */
  readonly component?: Class;
  readonly visitNumber?: number;
  readonly callId?: string;
  readonly itemIndex?: number;
  readonly copyNumber?: number;
}

/** What a unit test sets on its `ExecutionContext`; the rest takes its default. */
export interface TestExecutionContextOptions {
  readonly executionId?: string;
  readonly threadId?: string;
  readonly ownerId?: string;
  readonly signal?: AbortSignal;
  /** The `@Workflow` class (its `name` and `version` from its decorator). */
  readonly workflow?: WorkflowClass;
  readonly step?: TestStepOptions;
}

/** Stands in for a component a test does not name. */
class TestStep {
  declare readonly placeholder: "test-step";
}

/** Stands in for a workflow a test does not name. */
class TestWorkflow {
  declare readonly placeholder: "test-workflow";
}

/** A decorated class's `name` (a flow node's or a tool's), else its class name. */
function nameOf(cls: Class, fallback: string): string {
  const declared = declarationOf(cls)?.options.name;
  if (declared !== undefined) return declared;
  const meta = componentOf(cls)?.meta;
  if (meta !== undefined && "name" in meta) return meta.name;
  return cls === TestStep || cls === TestWorkflow ? fallback : cls.name;
}

/** The workflow of a unit test's execution: its decorator's name and version (`test-workflow`). */
export function testWorkflowOf(type: WorkflowClass = TestWorkflow): WorkflowDescriptor {
  const options = declarationOf(type)?.options;
  const version = options !== undefined && "version" in options ? options.version : "0.0.0";
  return Object.freeze({
    type,
    name: nameOf(type, "test-workflow"),
    version,
    startedVersion: version,
  });
}

/** The step of a unit test's execution: the component's name, its first visit by default. */
export function testStepOf(executionId: string, options: TestStepOptions): StepDescriptor {
  const type = options.component ?? TestStep;
  const name = nameOf(type, "test-step");
  const visitNumber = options.visitNumber ?? 1;
  const { callId, itemIndex } = options;
  return Object.freeze({
    component: Object.freeze({ type, name }),
    nodeId: name,
    visitNumber,
    idempotencyKey: idempotencyKeyOf({ executionId, nodeId: name, visitNumber, itemIndex, callId }),
    callId,
    itemIndex,
    copyNumber: options.copyNumber ?? 1,
  });
}

/** The application a unit test's context links up to; what is not given takes its default. */
export interface TestApplicationOptions {
  readonly name?: string;
  readonly version?: string;
  readonly instanceId?: string;
  readonly environmentName?: string;
  /** The environment's values (`applicationContext.environment`); default: none. */
  readonly environment?: Environment;
}

/** The context classes and values of a `testExecutionContext` (#261). */
export interface TestContextOptions<
  TExecution extends ExecutionContext,
  TTenant extends TenantContext,
> {
  /** The project's `ExecutionContext` subclass (default: the built-in class). */
  readonly executionContext?: ExecutionContextClass<TExecution>;
  /** The project's `TenantContext` subclass (default: the built-in class). */
  readonly tenantContext?: TenantContextClass<TTenant>;
  /** The tenant's values, checked by its class's field decorators; default `"default"`. */
  readonly tenant?: ContextValues<TTenant> | TenantValues;
  /** The execution subclass's values, checked by its field decorators. */
  readonly execution?: ContextValues<TExecution>;
  readonly application?: TestApplicationOptions;
}

const applicationOf = (options: TestApplicationOptions = {}): ApplicationContext =>
  applicationContextOf({
    name: options.name ?? "test-application",
    version: options.version ?? "0.0.0",
    instanceId: options.instanceId ?? "test-instance",
    startedAt: new Date(0),
    environmentName: options.environmentName ?? "test",
    environment: options.environment ?? NO_ENVIRONMENT_VALUES,
  });

/** The execution's own data: the values a unit test gave, read the same at any time. */
function executionDataOf(options: TestExecutionContextOptions): Readonly<Record<string, unknown>> {
  const executionId = options.executionId ?? "test-execution";
  return {
    executionId,
    threadId: options.threadId ?? executionId,
    ownerId: options.ownerId,
    signal: options.signal ?? new AbortController().signal,
    workflow: testWorkflowOf(options.workflow),
    step: testStepOf(executionId, options.step ?? {}),
    itemIndex: undefined,
    depth: 1,
    parent: undefined,
  };
}

/**
 * An `ExecutionContext` for a component created in a unit test without the container (#280, #261):
 * `new WriteAuditAction(testExecutionContext(), fakeAuditRepository)`. Frozen, one level (no
 * parent), readable at any time — no execution needed. Defaults: execution `test-execution`, its
 * own thread, no owner, a signal nobody aborts, step `test-step` on its first visit, the tenant
 * `"default"` of an application `test-application` on the `test` environment. With the project's
 * subclasses (`executionContext`, `tenantContext`) the values are checked by their decorators:
 * `testExecutionContext({ tenantContext: JobScoutTenantContext, tenant: { dailyBudget: usd(40) } }).tenant`.
 */
export function testExecutionContext<
  TExecution extends ExecutionContext = ExecutionContext,
  TTenant extends TenantContext = TenantContext,
>(
  options: TestExecutionContextOptions & TestContextOptions<TExecution, TTenant> = {},
): TExecution & { readonly tenant: TTenant } {
  const executionType = options.executionContext ?? ExecutionContext;
  const tenantType = options.tenantContext ?? TenantContext;
  const tenant = tenantContextOf(
    tenantType,
    tenantFieldsOf(tenantType, options.tenant),
    applicationOf(options.application),
  );
  const values = executionFieldsOf(executionType, options.execution);
  // the framework's instance of the context class: its prototype, the test's values as own fields
  const context = Object.create(executionType.prototype) as TExecution & {
    readonly tenant: TTenant;
  };
  Object.assign(context, executionDataOf(options), values, { tenant });
  Object.defineProperty(context, "root", { enumerable: true, value: context });
  Object.defineProperty(context, "executionOf", {
    value: (workflow: WorkflowClass) => (workflow === context.workflow.type ? context : undefined),
  });
  return Object.freeze(context);
}
