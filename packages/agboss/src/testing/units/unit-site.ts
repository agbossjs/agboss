import {
  createContainer,
  DependantValue,
  UnavailableValue,
  type Container,
} from "../../components/container/container.js";
import { contextValuesOf } from "../../components/context-tokens.js";
import type { Class, Token } from "../../components/injection.js";
import { JudgeModel } from "../../components/judge-decorators.js";
import { LiveJudgeModel } from "../../components/judge-call.js";
import { ROUTER_FACTORY } from "../../components/runtime.js";
import { LiveSpendRecorder, SpendRecorder } from "../../components/spend-recorder.js";
import { NO_ENVIRONMENT_VALUES } from "../../environments/resolve.js";
import { buildCostReport, type UsageRecord } from "../../finops/usage.js";
import { applicationContextOf } from "../../flow/context/application-context.js";
import { ExecutionContext } from "../../flow/context/execution-context.js";
import { runInFrame, type FrameSpec } from "../../flow/context/frame.js";
import { tenantOfExecution, type RuntimeContexts } from "../../flow/context/runtime-contexts.js";
import {
  executionFieldsOf,
  tenantFieldsOf,
  type ContextFields,
  type TenantFields,
} from "../../flow/context/context-values.js";
import { TenantContext } from "../../flow/context/tenant-context.js";
import { Clock } from "../../infrastructure/clock.js";
import { timeoutError, timeoutOn } from "../../infrastructure/clock-timeout.js";
import type { ModelGateway } from "../../llm/gateway.js";
import type { Milliseconds } from "../../units/index.js";
import { VirtualClock } from "../clock.js";
import { asError } from "../errors.js";
import { testStepOf, testWorkflowOf } from "../execution-context.js";
import { ScriptBook, type ModelScript } from "../script-book.js";
import type { TurnFor } from "../script-types.js";
import { createScriptedGateway } from "../scripted-gateway.js";
import type { UnitModelScript, UnitOptions, UnitRun } from "./unit-types.js";
import { replacementsOf } from "./override.js";
import { testFenceLeaseOf } from "../fence.js";
import type { FrameLease } from "../../flow/context/frame.js";

/**
 * What a unit runner runs a component on (#262 S55, S62): its own container (the component's
 * `deps`, the `overrides`, the core values — the live `ExecutionContext`, `SpendRecorder`,
 * `JudgeModel`, the runner's `Clock`), an application context of the test environment, the
 * scripted models of a test, and one frame per call: a step of the component in the execution
 * `test-execution` of the default tenant, with the call's signal (its timeout on the clock).
 */

/** The step a call runs as: its component and name, its cost caller, its tool call id. */
export interface UnitFrame {
  readonly component: Class;
  /** The cost caller of what the call records (`tool:<name>`, `action:<name>`, …). */
  readonly caller: string;
  readonly callId?: string;
  /** Aborts the call's signal after this long; `reason` is what it aborts with. */
  readonly timeout?: { readonly delay: Milliseconds; readonly reason: () => Error };
}

/** One call's work: what it gives, the spend it records itself (model calls), the call's signal. */
export type UnitWork<TOutput> = (call: UnitCall) => Promise<TOutput>;

/** What a call's work gets. */
export interface UnitCall {
  readonly signal: AbortSignal;
  /** Where a runner records the spend of the models it calls for the component. */
  readonly spent: UsageRecord[];
}

const UNIT_EXECUTION = "test-execution";

/** A call's `timeout` as its frame's: the signal aborts with a `TimeoutError`; none = never. */
export const callTimeoutOf = (timeout: Milliseconds | undefined): Pick<UnitFrame, "timeout"> =>
  timeout === undefined ? {} : { timeout: { delay: timeout, reason: timeoutError } };

/** The application context of a unit test: `test-application` on the `test` environment. */
function unitContexts(clock: Clock, options: UnitOptions): RuntimeContexts {
  const application = applicationContextOf({
    name: "test-application",
    version: "0.0.0",
    instanceId: "test-instance",
    startedAt: clock.now(),
    environmentName: "test",
    environment: options.environment ?? NO_ENVIRONMENT_VALUES,
  });
  return {
    application,
    tenantContext: options.tenantContext ?? TenantContext,
    executionContext: options.executionContext ?? ExecutionContext,
  };
}

const noRouterFactory = new UnavailableValue(
  (dependant) =>
    `${dependant} injects ROUTER_FACTORY, which a unit runner does not have — override the class that uses it`,
);

function unitContainer(clock: Clock, contexts: RuntimeContexts, options: UnitOptions): Container {
  const core = new Map<Token, unknown>([
    [ROUTER_FACTORY, noRouterFactory],
    ...contextValuesOf(contexts),
    [JudgeModel, new DependantValue((dependant) => new LiveJudgeModel(dependant))],
    [SpendRecorder, new DependantValue((dependant) => new LiveSpendRecorder(dependant))],
    [Clock, clock],
  ]);
  return createContainer(
    { modules: [], core },
    { replacements: replacementsOf(options.overrides) },
  );
}

/** One turn or a list of them, as the list. */
const turnsOf = <TSelf>(model: UnitModelScript<TSelf>): readonly TurnFor<TSelf>[] =>
  isTurnList(model) ? model : [model];

const isTurnList = <TSelf>(model: UnitModelScript<TSelf>): model is readonly TurnFor<TSelf>[] =>
  Array.isArray(model);

/** Rejects when the signal aborts, even if the work ignores it (as a tool call does, #280 S45). */
function untilAborted<TValue>(work: Promise<TValue>, signal: AbortSignal): Promise<TValue> {
  return new Promise((resolve, reject) => {
    signal.addEventListener("abort", () => {
      reject(asError(signal.reason));
    });
    work.then(resolve, reject);
  });
}

export class UnitSite {
  readonly clock = new VirtualClock();
  readonly book = new ScriptBook();
  readonly contexts: RuntimeContexts;
  readonly container: Container;
  /** The tenant's and the execution's values, validated once, as `app.execute` validates them. */
  readonly #tenant: TenantFields;
  readonly #execution: ContextFields;
  /** The lease its calls fence with (#471): held, token 1, unless the options say otherwise. */
  readonly #lease: FrameLease;
  #gateway: ModelGateway | undefined;

  constructor(options: UnitOptions) {
    this.contexts = unitContexts(this.clock, options);
    this.container = unitContainer(this.clock, this.contexts, options);
    this.#tenant = tenantFieldsOf(this.contexts.tenantContext, options.tenant);
    this.#execution = executionFieldsOf(this.contexts.executionContext, options.execution);
    this.#lease = testFenceLeaseOf(options.fence ?? {}, {
      tenantId: this.#tenant.tenantId,
      executionId: UNIT_EXECUTION,
      clock: this.clock,
    });
  }

  /** The component's instance (its `deps` resolved, `overrides` applied). */
  instanceOf(component: Class): unknown {
    return this.container.get(component);
  }

  /** The scripted model gateway of the runner: every model answers from its script. */
  get gateway(): ModelGateway {
    return (this.#gateway ??= createScriptedGateway(this.book, this.clock));
  }

  /** Scripts the model whose calls are keyed `key` (its cost caller), named `label` in messages. */
  scriptModel<TSelf>(key: string, label: string, model: UnitModelScript<TSelf> | undefined): void {
    this.book.name(key, label);
    if (model === undefined) return;
    const script: ModelScript = this.book.scriptOf(key);
    const typed: ModelScript<TSelf> = script;
    typed.thenReturn(...turnsOf(model));
  }

  /** Runs one call in its frame; a failure the scripts reported wins over what the call threw. */
  async run<TOutput>(frame: UnitFrame, work: UnitWork<TOutput>): Promise<UnitRun<TOutput>> {
    const spent: UsageRecord[] = [];
    const timeout =
      frame.timeout && timeoutOn(this.clock, frame.timeout.delay, frame.timeout.reason);
    const signal = timeout?.signal ?? new AbortController().signal;
    const reportUsage = (record: UsageRecord): void => {
      spent.push({ ...record, caller: frame.caller });
    };
    const spec = { ...this.#frameOf(frame, signal), services: { reportUsage } };
    try {
      const output = await runInFrame(spec, () => untilAborted(work({ signal, spent }), signal));
      const failure = this.book.takeFailure();
      if (failure !== undefined) throw failure;
      return { output, spend: buildCostReport(spent) };
    } catch (error) {
      throw this.book.takeFailure() ?? error;
    } finally {
      timeout?.release();
    }
  }

  #frameOf(frame: UnitFrame, signal: AbortSignal): FrameSpec {
    const workflow = testWorkflowOf();
    return {
      execution: Object.freeze({
        executionId: UNIT_EXECUTION,
        threadId: UNIT_EXECUTION,
        ownerId: undefined,
        signal,
        workflow,
        tenant: tenantOfExecution(this.contexts, this.#tenant),
        values: this.#execution,
        lease: this.#lease,
      }),
      step: testStepOf(UNIT_EXECUTION, {
        component: frame.component,
        ...(frame.callId === undefined ? {} : { callId: frame.callId }),
      }),
    };
  }
}
