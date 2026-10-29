import { contextFieldNamesOf, type ExecutionContextClass } from "./context-values.js";
import type { ExecutionContext, StepDescriptor, WorkflowClass } from "./execution-context.js";
import { depthOf, type ExecutionFacts } from "./frame.js";
import { ancestorFenceRead } from "./execution-fence.js";

/**
 * The ancestors of an execution as its `ExecutionContext` shows them (#263): `parent`, `root` and
 * `executionOf(W)` of a child give the context of an execution above it — a frozen instance of the
 * declared class over that execution's facts and the step that launched the child below it. They
 * do not move: an ancestor is waiting at its launching step while the child runs.
 */

/** The fields every ancestor context has, read from its facts and its launching step. */
function ownValues(facts: ExecutionFacts, step: StepDescriptor): Readonly<Record<string, unknown>> {
  return {
    executionId: facts.executionId,
    threadId: facts.threadId,
    ownerId: facts.ownerId,
    tenant: facts.tenant,
    signal: facts.signal,
    workflow: facts.workflow,
    step,
    itemIndex: facts.itemIndex,
    depth: depthOf(facts),
    origin: facts.origin,
  };
}

const known = new WeakMap<ExecutionFacts, WeakMap<ExecutionContextClass, ExecutionContext>>();

/** The context of an ancestor execution, one object per execution and class. */
export function ancestorContextOf(
  type: ExecutionContextClass,
  facts: ExecutionFacts,
  step: StepDescriptor,
): ExecutionContext {
  const byType = known.get(facts) ?? new WeakMap<ExecutionContextClass, ExecutionContext>();
  known.set(facts, byType);
  const found = byType.get(type);
  if (found !== undefined) return found;
  // the framework's instance of the declared class: its prototype, every field a plain value
  const context = Object.create(type.prototype as object) as ExecutionContext;
  const fields = new Map<string, unknown>(Object.entries(ownValues(facts, step)));
  for (const field of contextFieldNamesOf(type))
    fields.set(field, Reflect.get(facts.values, field));
  for (const [field, value] of fields)
    Object.defineProperty(context, field, { enumerable: true, value });
  const parent = parentContextOf(type, facts);
  Object.defineProperty(context, "parent", { enumerable: true, value: parent });
  // an ancestor's lease is never fenced with (#471): it may be yielded or held on another instance
  Object.defineProperty(context, "fence", {
    enumerable: false,
    get: () => ancestorFenceRead(type.name),
  });
  Object.defineProperty(context, "root", {
    enumerable: true,
    get: () => parent?.root ?? context,
  });
  Object.defineProperty(context, "executionOf", {
    value: (workflow: WorkflowClass) =>
      facts.workflow.type === workflow ? context : parent?.executionOf(workflow),
  });
  byType.set(type, Object.freeze(context));
  return context;
}

/** The context of the execution that launched `facts`; `undefined` at the root. */
export function parentContextOf(
  type: ExecutionContextClass,
  facts: ExecutionFacts,
): ExecutionContext | undefined {
  const { parent } = facts;
  return parent === undefined ? undefined : ancestorContextOf(type, parent.execution, parent.step);
}
