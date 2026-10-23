import type { Class } from "../../components/injection.js";
import {
  executionFieldsOf,
  tenantFieldsOf,
  type ContextFields,
  type TenantFields,
} from "../../flow/context/context-values.js";
import type { FrameSpec } from "../../flow/context/frame.js";
import { idempotencyKeyOf } from "../../flow/context/idempotency.js";
import { standaloneContexts, tenantOfExecution } from "../../flow/context/runtime-contexts.js";
import { bareRecordOf, ComponentKind } from "../../flow/runtime/records.js";
import { workflowIdentityOf } from "../../flow/runtime/workflow-keys.js";
import type { GraphDeps } from "../../graph/deps.js";

/**
 * The frame an eval judge runs in (#396 PR 2, S2): the case's last execution — its id, thread,
 * tenant (the project's `TenantContext` with the case's values) and execution fields — with the
 * judge as its step, so a judge's injected `ExecutionContext` / `TenantContext` read that execution.
 */

/** A case's context values as its executions keep them: validated by the application's classes. */
export interface CaseContextValues {
  readonly tenant: TenantFields;
  readonly execution: ContextFields;
}

/** The case's `tenant` / `execution`, validated as `app.execute` validates them. */
export function caseContextValuesOf(
  deps: GraphDeps<string>,
  given: { readonly tenant?: unknown; readonly execution?: unknown },
): CaseContextValues {
  const contexts = deps.contexts ?? standaloneContexts(workflowIdentityOf(deps));
  return {
    tenant: tenantFieldsOf(contexts.tenantContext, given.tenant),
    execution: executionFieldsOf(contexts.executionContext, given.execution),
  };
}

/** The execution a judge judges: the case's last turn. */
export interface JudgedExecution {
  readonly executionId: string;
  readonly threadId: string;
  readonly values: CaseContextValues;
}

/** The frame of one judge on the case's last execution. */
export function judgeFrameOf(
  deps: GraphDeps<string>,
  execution: JudgedExecution,
  judge: { readonly type: Class; readonly name: string },
): FrameSpec {
  const identity = workflowIdentityOf(deps);
  const contexts = deps.contexts ?? standaloneContexts(identity);
  const { executionId, threadId, values } = execution;
  const visitNumber = 1;
  return {
    execution: Object.freeze({
      executionId,
      threadId,
      ownerId: undefined,
      signal: new AbortController().signal,
      workflow: Object.freeze({ ...identity, startedVersion: identity.version }),
      tenant: tenantOfExecution(contexts, values.tenant),
      values: values.execution,
    }),
    step: Object.freeze({
      component: Object.freeze({
        type: judge.type,
        ...bareRecordOf(judge.name, ComponentKind.Judge),
      }),
      nodeId: judge.name,
      visitNumber,
      idempotencyKey: idempotencyKeyOf({ executionId, nodeId: judge.name, visitNumber }),
      callId: undefined,
      itemIndex: undefined,
      copyNumber: 1,
      toolLoopIteration: undefined,
      validationAttempts: 0,
    }),
  };
}
