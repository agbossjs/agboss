import { ExecutionContextUnavailableError } from "./errors.js";
import {
  contextFieldNamesOf,
  type ExecutionContextClass,
  type TenantContextClass,
} from "./context-values.js";
import { ExecutionContext, type WorkflowClass } from "./execution-context.js";
import { currentFrame, depthOf, type ExecutionFacts, type Frame } from "./frame.js";
import { ancestorContextOf, parentContextOf } from "./ancestor-context.js";
import { TenantContext } from "./tenant-context.js";

/**
 * The injected contexts (#280, #261): one object per consumer whose every field reads the frame of
 * the current async context — so it is safe in any component (one instance per application) and in
 * parallel branches. No frame → `ExecutionContextUnavailableError` (outside an execution); a closed
 * frame → the same error naming the ended step (S18). An instance of the declared class (the
 * project's subclass, its own fields read from the execution's values), frozen: nothing is set
 * through it. The tree (#263): `parent`, `root` and `executionOf(W)` give the contexts of the
 * executions above a child (`ancestor-context.ts`).
 */

/** The current frame for a read of `field` by `consumer`; none or closed → the error. */
function frameFor(consumer: string, field: string): Frame {
  const frame = currentFrame();
  if (frame === undefined) throw ExecutionContextUnavailableError.outside({ consumer, field });
  if (frame.isClosed()) {
    throw ExecutionContextUnavailableError.ended(frame.step, frame.execution.executionId);
  }
  return frame;
}

/** A getter of the live object. */
type Read = (frame: Frame) => unknown;

/** A frozen instance of `type` whose listed fields read the current frame. */
function liveObject(
  type: abstract new () => unknown,
  prefix: string,
  consumer: string,
  reads: ReadonlyMap<string, Read>,
): object {
  // the framework's instance of the context class: its prototype, every field a getter
  const live = Object.create(type.prototype as object) as object;
  for (const [field, read] of reads) {
    Object.defineProperty(live, field, {
      enumerable: true,
      get: () => read(frameFor(consumer, `${prefix}.${field}`)),
    });
  }
  return live;
}

/** Reads of the project's own fields: `frame.execution.<what>[field]`. */
const ownFields = (
  type: abstract new () => unknown,
  of: (execution: ExecutionFacts) => object,
): [string, Read][] =>
  contextFieldNamesOf(type).map((field) => [
    field,
    (frame): unknown => {
      const value: unknown = Reflect.get(of(frame.execution), field);
      return value;
    },
  ]);

const tenantReads = (type: TenantContextClass): ReadonlyMap<string, Read> =>
  new Map<string, Read>([
    ["tenantId", (frame) => frame.execution.tenant.tenantId],
    ["weight", (frame) => frame.execution.tenant.weight],
    ["application", (frame) => frame.execution.tenant.application],
    ...ownFields(type, (execution) => execution.tenant),
  ]);

/** The injected `TenantContext` (or the project's subclass) of `consumer`. */
export function liveTenantContextOf(
  type: TenantContextClass = TenantContext,
  consumer = "the app",
): TenantContext {
  // built from the class's prototype: an instance of it, the project's methods included
  return Object.freeze(
    liveObject(type, "tenantContext", consumer, tenantReads(type)),
  ) as TenantContext;
}

const executionReads = (type: ExecutionContextClass): ReadonlyMap<string, Read> =>
  new Map<string, Read>([
    ["executionId", (frame) => frame.execution.executionId],
    ["threadId", (frame) => frame.execution.threadId],
    ["ownerId", (frame) => frame.execution.ownerId],
    ["tenant", (frame) => frame.execution.tenant],
    ["signal", (frame) => frame.execution.signal],
    ["workflow", (frame) => frame.execution.workflow],
    ["step", (frame) => frame.step],
    ["itemIndex", (frame) => frame.execution.itemIndex],
    ["parent", (frame) => parentContextOf(type, frame.execution)],
    ["depth", (frame) => depthOf(frame.execution)],
    ...ownFields(type, (execution) => execution.values),
  ]);

/** The root of the current execution's tree: `live` itself at the root. */
function rootOf(type: ExecutionContextClass, live: object, frame: Frame): unknown {
  const { parent } = frame.execution;
  if (parent === undefined) return live;
  return ancestorContextOf(type, parent.execution, parent.step).root;
}

/** The injected `ExecutionContext` (or the project's subclass) of `consumer`. */
export function liveExecutionContextOf(
  type: ExecutionContextClass = ExecutionContext,
  consumer = "the app",
): ExecutionContext {
  const live = liveObject(type, "executionContext", consumer, executionReads(type));
  // the root: this execution at the root, else the context of the execution at the top (#263)
  Object.defineProperty(live, "root", {
    enumerable: true,
    get: () => rootOf(type, live, frameFor(consumer, "executionContext.root")),
  });
  Object.defineProperty(live, "executionOf", {
    value: (workflow: WorkflowClass) => {
      const frame = frameFor(consumer, "executionContext.executionOf");
      if (frame.execution.workflow.type === workflow) return live;
      return parentContextOf(type, frame.execution)?.executionOf(workflow);
    },
  });
  // an instance of the declared class whose every field is a getter over the current frame
  return Object.freeze(live) as ExecutionContext;
}
