import { recordOptionKeys } from "../components/option-keys.js";
import { OBSERVER_KEYS } from "../components/decorator-options.js";
import type { ValuesOutdatedEvent } from "../flow/observers/values-outdated.js";
import type { LaunchItemsTruncatedEvent } from "../flow/observers/launch-items-truncated.js";
import type { CompactionEndEvent, CompactionStartEvent } from "../flow/observers/compaction.js";
import type { QuorumDecidedEvent } from "../flow/observers/quorum-decided.js";
import type { ArbiterEndEvent, ArbiterStartEvent } from "../flow/observers/arbiter.js";
import type { RerankEndEvent, RerankStartEvent } from "../flow/observers/rerank.js";
import type { ModelFallbackEvent } from "../flow/observers/model-fallback.js";
import type {
  ChannelInterpreterEndEvent,
  ChannelInterpreterStartEvent,
} from "../flow/observers/channel-interpreter.js";
import type { TtlSweepEvent } from "../flow/observers/ttl-sweep.js";
import type {
  PauseReassignedEvent,
  PauseTimeoutChangedEvent,
} from "../flow/observers/pause-changes.js";
import type { CircuitStateChangeEvent } from "../flow/observers/circuit-state.js";
import type {
  CompensationEndEvent,
  CompensationStartEvent,
} from "../flow/observers/compensation-events.js";
import type {
  ExecutionLeaseTakeoverEvent,
  IdempotencyRunEvent,
  OutboundCallEvent,
  StepHandedOverEvent,
} from "../flow/observers/audit-log.js";
import type {
  ActionEndEvent,
  ActionStartEvent,
  AgentEndEvent,
  AgentStartEvent,
  ChannelEndEvent,
  ChannelStartEvent,
  GuardrailEndEvent,
  GuardrailStartEvent,
  JudgeEndEvent,
  JudgeStartEvent,
  ModelEndEvent,
  ModelStartEvent,
  RagEndEvent,
  RagStartEvent,
  RouterEndEvent,
  RouterStartEvent,
  ExecutionEndEvent,
  ExecutionCancelEvent,
  ExecutionErrorEvent,
  ExecutionStopEvent,
  InterruptCleanupErrorEvent,
  ExecutionPauseEvent,
  ExecutionRejectedEvent,
  ExecutionResumeEvent,
  ExecutionStartEvent,
  AgentRetryEvent,
  ToolEndEvent,
  ToolStartEvent,
} from "./observability.js";
import type { Class, ResolvedAll, Token } from "../components/injection.js";
import { componentOf, recordComponent } from "../components/metadata.js";
import { resolvedName } from "../flow/names.js";
import { nameOf } from "../components/name-of.js";
import { ComponentKind } from "../flow/runtime/records.js";

/**
 * Every observer hook, all optional (#261, #1343): an observer class — `@Observer`, listed in
 * `@Application({ observers })`, the only place observers are registered — declares the ones it
 * wants as methods. Every execution of the application is observed, child executions included;
 * `@Observer({ workflows, agents })` narrows what its hooks receive.
 */
export interface ExecutionObserver {
  /** Once per execution, at `execute` (a resume does not start it again). */
  onExecutionStart?(event: ExecutionStartEvent): void | Promise<void>;
  /** The execution paused (an approval, a channel); `onExecutionResume` follows when it continues. */
  onExecutionPause?(event: ExecutionPauseEvent): void | Promise<void>;
  /** `app.resume` picked the paused execution up, or recovery continues an interrupted one. */
  onExecutionResume?(event: ExecutionResumeEvent): void | Promise<void>;
  /** A request was refused before an execution started or was located (`execute`, `resume` or `cancel` of another owner's thread, a resume with nothing paused, an unknown thread, invalid input, an exhausted budget, a stopping app). */
  onExecutionRejected?(event: ExecutionRejectedEvent): void | Promise<void>;
  /** The execution ended at a finish: at `execute`, or after a resume; once per execution. */
  onExecutionEnd?(event: ExecutionEndEvent): void | Promise<void>;
  /** The execution was stopped: halted where it stood, nothing undone; once per execution. */
  onExecutionStop?(event: ExecutionStopEvent): void | Promise<void>;
  /** The execution was cancelled (running or paused): aborted and its open undoable actions undone; once per execution. */
  onExecutionCancel?(event: ExecutionCancelEvent): void | Promise<void>;
  /** The execution failed (also after a resume), or a resume of a paused one was refused as incompatible (`IncompatibleResumeError`; it stays paused). A cancel is `onExecutionCancel`. */
  onExecutionError?(event: ExecutionErrorEvent): void | Promise<void>;
  onAgentStart?(event: AgentStartEvent): void | Promise<void>;
  onAgentEnd?(event: AgentEndEvent): void | Promise<void>;
  /** An agent corrects itself: one iteration of its internal retry loop (an invalid answer, invalid tool input, a judge's rejection), before it asks its model again. */
  onAgentRetry?(event: AgentRetryEvent): void | Promise<void>;
  onRouterStart?(event: RouterStartEvent): void | Promise<void>;
  onRouterEnd?(event: RouterEndEvent): void | Promise<void>;
  onToolStart?(event: ToolStartEvent): void | Promise<void>;
  onToolEnd?(event: ToolEndEvent): void | Promise<void>;
  /** Every model call of an agent. */
  onModelStart?(event: ModelStartEvent): void | Promise<void>;
  onModelEnd?(event: ModelEndEvent): void | Promise<void>;
  onRagStart?(event: RagStartEvent): void | Promise<void>;
  onRagEnd?(event: RagEndEvent): void | Promise<void>;
  onGuardrailStart?(event: GuardrailStartEvent): void | Promise<void>;
  onGuardrailEnd?(event: GuardrailEndEvent): void | Promise<void>;
  onActionStart?(event: ActionStartEvent): void | Promise<void>;
  onActionEnd?(event: ActionEndEvent): void | Promise<void>;
  onChannelStart?(event: ChannelStartEvent): void | Promise<void>;
  onChannelEnd?(event: ChannelEndEvent): void | Promise<void>;
  onJudgeStart?(event: JudgeStartEvent): void | Promise<void>;
  onJudgeEnd?(event: JudgeEndEvent): void | Promise<void>;
  /** A write outdated values of the path scope (#271): once per cascade, with the reasons; never empty, never the DTO values. */
  onValuesOutdated?(event: ValuesOutdatedEvent): void | Promise<void>;
  /** A per-item launch took the first items of a longer list (#273): once per such launch, with how many items there were; truncation is never an error. */
  onLaunchItemsTruncated?(event: LaunchItemsTruncatedEvent): void | Promise<void>;
  /** A quorum join decided (#279): once per quorum, before the execution goes on (or into `.onError`). */
  onQuorumDecided?(event: QuorumDecidedEvent): void | Promise<void>;
  /** A model provider's circuit breaker changed state (#1313): opened, opened again after a failed probe, or closed. An event of the application: no `workflows` / `agents` filter lets it through. */
  onCircuitStateChange?(event: CircuitStateChangeEvent): void | Promise<void>;
  /** A memory starts summarising the turns older than its readers' window (#1303): before a new execution reads its thread, once per memory that has turns due. */
  onCompactionStart?(event: CompactionStartEvent): void | Promise<void>;
  /** A memory ended summarising (#1303), with what it spent; a failed compaction fails the execution (`StepError.Memory`) and has no end. */
  onCompactionEnd?(event: CompactionEndEvent): void | Promise<void>;
  /** #1283: an arbiter starts judging one answer of a quorum launch, in its branch's step; once per answer judged. A model arbiter's judging, or a code arbiter's `@Arbitrate` method. */
  onArbiterStart?(event: ArbiterStartEvent): void | Promise<void>;
  /** An arbiter ended judging (`ArbiterOutcome`), with what it spent; once per `onArbiterStart`, also when it failed. */
  onArbiterEnd?(event: ArbiterEndEvent): void | Promise<void>;
  /** A knowledge base's reranker starts on the retrieval's candidates (#1299); an empty retrieval has none. */
  onRerankStart?(event: RerankStartEvent): void | Promise<void>;
  /** A reranker ended (`RerankOutcome`: reranked, fell back, failed), with what it spent; once per `onRerankStart`. */
  onRerankEnd?(event: RerankEndEvent): void | Promise<void>;
  /** A model call moved down its provider's fallback chain (#202): once per hop it tries, before the fallback is asked, in the step it is made for. */
  onModelFallback?(event: ModelFallbackEvent): void | Promise<void>;
  /** A `@ChannelInterpreter` starts reading a free-text reply (#1310), before its pause is closed. */
  onChannelInterpreterStart?(event: ChannelInterpreterStartEvent): void | Promise<void>;
  /** An interpreter ended reading (`ChannelInterpreterOutcome`), with what it spent; once per `onChannelInterpreterStart`. */
  onChannelInterpreterEnd?(event: ChannelInterpreterEndEvent): void | Promise<void>;
  /** A look of the retention sweep ended: the rows each kind lost, how long it took and which stores failed. An event of the application: no `workflows` / `agents` filter lets it through. */
  onTtlSweep?(event: TtlSweepEvent): void | Promise<void>;
  /** An operator moved a pause's deadline later (`app.extendPause`, #942): once, by the call that won; never the pause's id. */
  onPauseTimeoutChanged?(event: PauseTimeoutChangedEvent): void | Promise<void>;
  /** An operator moved a pause to another addressee (`app.reassignPause`, #946): once, by the call that won; never the pause's id or the assignee. */
  onPauseReassigned?(event: PauseReassignedEvent): void | Promise<void>;
  /** An automatic undo action starts (#340): before each one runs, in its frame. */
  onCompensationStart?(event: CompensationStartEvent): void | Promise<void>;
  /** An automatic undo action ended: `Compensated` or `Failed` (with its `error`). */
  onCompensationEnd?(event: CompensationEndEvent): void | Promise<void>;
  /**
   * An instance took a tree's lease over (#501): the recovery sweep, an undo's takeover, a remote
   * child's reclaim or its holder's reclaim after a yield. Called once per takeover, after its row
   * of the audit log is written, before the tree moves on; a throw is only a warning.
   */
  onExecutionLeaseTakeover?(event: ExecutionLeaseTakeoverEvent): void | Promise<void>;
  /**
   * A step stopped without failing (#501): its lease was lost, an external system fenced its write,
   * or the instance stopped. Called once per hand-over, before the moving call rejects.
   */
  onStepHandedOver?(event: StepHandedOverEvent): void | Promise<void>;
  /**
   * An `executionContext.onInterrupted` cleanup of a step threw (#1341b): once per failing cleanup,
   * after it, before the next one runs. The execution's outcome is unchanged — never
   * `onExecutionError`. A throw here is only a warning.
   */
  onInterruptCleanupError?(event: InterruptCleanupErrorEvent): void | Promise<void>;
  /**
   * A step's fenced effect was called (#501): ran, replayed, joined or refused. Called once per
   * call of `runOnce`, after its outcome is known; a throw never reaches the effect or its step.
   */
  onIdempotencyRun?(event: IdempotencyRunEvent): void | Promise<void>;
  /**
   * A step's call that leaves the system moved (#505). Called once per move of the call, in the
   * order of the moves; a throw never reaches the call or its step.
   */
  onOutboundCall?(event: OutboundCallEvent): void | Promise<void>;
}

/** The name of a hook, e.g. `"onToolEnd"`. */
export type ObserverHook = keyof ExecutionObserver;

/** A class for `@Application({ observers })`: its instances implement some of the hooks. */
export type ObserverClass = Class<ExecutionObserver>;

import { HOOKS } from "./observer-hook-names.js";

export const OBSERVER_HOOKS: readonly ObserverHook[] = Object.keys(HOOKS).filter(
  (name): name is ObserverHook => name in HOOKS,
);

/** `@Observer` options (#1343): every one optional. */
export interface ObserverOptions<TDeps extends readonly Token[] = readonly Token[]> {
  /** Kebab-case, unique among the application's observers; the class name in kebab-case when left out (`DeskMetricsObserver` → `desk-metrics-observer`). */
  readonly name?: string;
  readonly description?: string;
  /** Only the events of these `@Workflow` classes; absent = every workflow's (and the app-level ones). */
  readonly workflows?: readonly Class[];
  /** Only the events of these `@Agent` classes; absent = every agent's (and the events of no agent). */
  readonly agents?: readonly Class[];
  /** The constructor's dependencies, in order (compiler-checked), injected by the container. */
  readonly deps?: TDeps;
}

/** What `@Observer` records about a class. */
export interface ObserverMeta {
  readonly name: string;
  readonly description?: string;
  readonly workflows: readonly Class[];
  readonly agents: readonly Class[];
  readonly deps: readonly Token[];
}

/**
 * An execution observer: a class with `on…` hook methods (`onExecutionEnd`, `onToolEnd`,
 * `onAgentRetry`, …), created by the application's container like any component and listed only in
 * `@Application({ observers })`. A hook that is no observer hook fails assembly
 * (`[observer.unknown-hook]`). `workflows` and `agents` filter what its hooks receive, so a hook
 * needs no `if (event.workflow.name !== nameOf(…)) return;`.
 */
export function Observer<const TDeps extends readonly Token[] = []>(
  options: ObserverOptions<TDeps> = {},
) {
  return <TClass extends new (...args: ResolvedAll<TDeps>) => ExecutionObserver>(
    value: TClass,
  ): TClass => {
    recordOptionKeys(value, "Observer", options, OBSERVER_KEYS);
    const { description, workflows = [], agents = [], deps = [] } = options;
    const meta = { name: resolvedName(options.name, value), workflows, agents, deps };
    recordComponent(value, {
      kind: "observer",
      meta: description === undefined ? meta : { ...meta, description },
    });
    return value;
  };
}

/** What `@Observer` recorded on a class; `undefined` when it is not an observer. */
export function observerOf(cls: Class): ObserverMeta | undefined {
  const component = componentOf(cls);
  return component?.kind === "observer" ? component.meta : undefined;
}

/** What an `@Observer({ workflows, agents })` lets through, as names; `undefined` = everything. */
interface ObserverFilter {
  readonly workflows: ReadonlySet<string>;
  readonly agents: ReadonlySet<string>;
}

const filters = new WeakMap<object, ObserverFilter | null>();

/** The filter of an observer instance's class; none for an observer without `workflows` and `agents`. */
function filterOf(observer: ExecutionObserver): ObserverFilter | undefined {
  const cached = filters.get(observer);
  if (cached !== undefined) return cached ?? undefined;
  const meta = observerOf(observer.constructor as Class);
  const filter =
    meta === undefined || (meta.workflows.length === 0 && meta.agents.length === 0)
      ? undefined
      : {
          workflows: new Set(meta.workflows.map((cls) => nameOf(cls))),
          agents: new Set(meta.agents.map((cls) => nameOf(cls))),
        };
  filters.set(observer, filter ?? null);
  return filter;
}

/** The agent an event is about: its own `agent`, else the agent whose step it is; none for the rest. */
function agentOf(event: object): string | undefined {
  if ("agent" in event && typeof event.agent === "string") return event.agent;
  if (!("step" in event)) return undefined;
  const component = (event.step as { readonly component: AgentRetryEvent["step"]["component"] })
    .component;
  return component.kind === ComponentKind.Agent ? component.name : undefined;
}

/** The name of the workflow an event is about: its record's `name`, or the name itself (a pause's events carry no record). */
function workflowNameOf(event: object): string | undefined {
  if (!("workflow" in event)) return undefined;
  const workflow = event.workflow as { readonly name: string } | string;
  return typeof workflow === "string" ? workflow : workflow.name;
}

/** Whether the observer's `workflows` / `agents` let the event through (an unfiltered side lets all). */
export function isWanted(observer: ExecutionObserver, event: object): boolean {
  const filter = filterOf(observer);
  if (filter === undefined) return true;
  if (filter.workflows.size > 0) {
    const name = workflowNameOf(event);
    if (name === undefined || !filter.workflows.has(name)) return false;
  }
  if (filter.agents.size > 0) {
    const agent = agentOf(event);
    if (agent === undefined || !filter.agents.has(agent)) return false;
  }
  return true;
}
