import { keyTextRuleOf } from "../core/errors.js";
import type { Infrastructure } from "../infrastructure/contracts.js";
import {
  definedOf,
  lazyLoad,
  reservedExecutionIdsOf,
  unkeptExecutionIds,
  type ExecutionIds,
  type ReservedExecutionIds,
} from "../infrastructure/clock.js";
import {
  rememberExecutionControl,
  type ExecutionControl,
  type WorkflowExecutionControl,
} from "./execution-control.js";
import type { App } from "./types.js";
import type { ExecutionTreeParts } from "./execution-trees.js";
import type { AppDeps } from "./app-deps.js";

/**
 * The reserved execution id (#807, A2A design §4.1.3 step 6, internal): a transport that knows its
 * execution's id before `app.execute` returns — an A2A task's id, saved with the task when it is
 * accepted — passes it as a hidden option (a symbol: no public option, kept by a spread, like the
 * inbound mesh). `execute` keeps that id in the lease store instead of minting one
 * (`ReservedExecutionIds.keep`), so an id another execution ever had — the same task started again
 * on a resend, on another instance, after a crash, or an id a sweep fenced — is
 * `DuplicateExecutionIdError` before anything of the run is written.
 */
const RESERVED_EXECUTION_ID: unique symbol = Symbol("agboss.reserved-execution-id");

/**
 * The execution options that run under `executionId`. The id is a key's text (#578), else a
 * `RangeError` naming the rule, never the id: a transport's bug, refused before any call.
 */
export function withReservedExecutionId<TOptions extends object>(
  options: TOptions,
  executionId: string,
): TOptions {
  const rule = keyTextRuleOf(executionId);
  if (rule !== undefined) throw new RangeError(`a reserved execution id breaks the rule "${rule}"`);
  return { ...options, [RESERVED_EXECUTION_ID]: executionId };
}

/** The execution id a transport reserved for this execution, if any. */
export const reservedExecutionIdOf = (options: object): string | undefined =>
  // only `withReservedExecutionId` sets it, to a checked text
  Reflect.get(options, RESERVED_EXECUTION_ID) as string | undefined;

/**
 * A run no recovery continues (#860, internal): a transport that answers its caller from the run
 * alone — a direct A2A message — and keeps no task to show a later pass to. An instance that takes
 * its tree over (a recovery) ends it as cancelled without a pass, as a cancel request: the caller
 * is gone, a second pass would call its models again for no one.
 */
const WITHOUT_RECOVERY: unique symbol = Symbol("agboss.without-recovery");

/**
 * What a run no recovery continues says of itself: whether it can call a model — a lost pass of one
 * that can is a call of unknown cost (#853's Unknown entry), recorded by the instance that ends it.
 */
export interface WithoutRecoveryMark {
  readonly callsModel: boolean;
}

/** The execution options of a run no recovery continues. */
export const withoutRecovery = <TOptions extends object>(
  options: TOptions,
  mark: WithoutRecoveryMark,
): TOptions => ({ ...options, [WITHOUT_RECOVERY]: { callsModel: mark.callsModel } });

/** What a transport said of a run no recovery continues; `undefined` for any other run. */
export const withoutRecoveryOf = (options: object): WithoutRecoveryMark | undefined =>
  // only `withoutRecovery` sets it, to a mark
  Reflect.get(options, WITHOUT_RECOVERY) as WithoutRecoveryMark | undefined;

/** One tree of a workflow by its id (#807), loaded on first use. */
const executionTrees = () => lazyLoad(import("./execution-trees.js"));

/** What a workflow's app does to its trees by id (#807), and the ids transports reserve for them. */
export interface TreeControl {
  /** One of its trees by its root execution id: its durable state, a cancel of it alone. */
  readonly control: WorkflowExecutionControl;
  /** The ids transports reserve for its executions, kept where minted ids are. */
  readonly reservedIds: ReservedExecutionIds;
}

export const treeControlOf = (
  { idGenerator, executionLeases }: Pick<Infrastructure, "idGenerator" | "executionLeases">,
  parts: ExecutionTreeParts,
): TreeControl => ({
  control: {
    cancelExecution: async (request) => (await executionTrees()).cancelExecution(parts, request),
    executionStateOf: async (tree) => (await executionTrees()).executionStateOf(parts, tree),
  },
  reservedIds: reservedExecutionIdsOf(idGenerator, executionLeases),
});

/**
 * A new root execution's id, kept before anything of it is written (#591): the id a transport
 * reserved for it (#807: an A2A task's), else one minted now.
 */
export function runIdOf(
  call: object,
  tenantId: string,
  minted: ExecutionIds | undefined,
  reserved: ReservedExecutionIds,
): Promise<string> {
  const executionId = reservedExecutionIdOf(call);
  return executionId === undefined
    ? (minted ?? unkeptExecutionIds).newExecutionId(tenantId)
    : reserved.keep({ executionId, tenantId });
}

/** A built workflow of an instance: its records (whose threads it has) and its trees by id. */
export interface ControlledWorkflow extends TreeControl {
  readonly deps: {
    readonly turns: Pick<AppDeps["turns"], "hasThread">;
    readonly config: Pick<AppDeps["config"], "name">;
  };
}

/**
 * One tree of an instance by its root execution id (#807): handled by the workflow its thread
 * belongs to — a thread not created yet (an execution not started) by the first, whose stores are
 * the instance's, so a request it saves is the one the execution reads when it starts. `workflows`
 * is read at each call: the instance's, as they are built.
 */
export function instanceExecutionControlOf(
  workflows: readonly ControlledWorkflow[],
): ExecutionControl {
  const first = (): ControlledWorkflow =>
    definedOf(workflows[0], "an instance has a workflow once it is built");
  const ofThread = async (tenantId: string, threadId: string): Promise<TreeControl> => {
    for (const workflow of workflows) {
      const { turns, config } = workflow.deps;
      if (await turns.hasThread(config.name, tenantId, threadId)) return workflow;
    }
    return first();
  };
  return {
    cancelExecution: async (request) =>
      (await ofThread(request.tenantId, request.threadId)).control.cancelExecution(request),
    executionStateOf: async (tree) =>
      (await ofThread(tree.tenantId, tree.threadId)).control.executionStateOf(tree),
    claimExecutionId: (identity) => first().reservedIds.claim(identity),
  };
}

/**
 * An instance once composed, its trees reachable by id (#807: an A2A transport's tasks) — by its app,
 * and by its infrastructure for the framework's own observers (the A2A task projection).
 */
export function withExecutionControl<
  TInstance extends { readonly app: App; readonly infrastructure: object },
>(instance: TInstance, workflows: readonly ControlledWorkflow[]): TInstance {
  const control = instanceExecutionControlOf(workflows);
  rememberExecutionControl(instance.app, control);
  rememberExecutionControl(instance.infrastructure, control);
  return instance;
}
