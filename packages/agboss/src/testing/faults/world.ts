import { systemClock } from "../../infrastructure/clock.js";
import { seconds, type Milliseconds } from "../../units/index.js";
import {
  tcpTargetOf,
  throughProxy,
  type FaultPodOptions,
  type FaultWorldOptions,
} from "./world-options.js";

export {
  tcpTargetOf,
  type FaultDatabase,
  type FaultPodOptions,
  type FaultWorldOptions,
} from "./world-options.js";
import { DatabaseProxy } from "./database-proxy.js";
import type { FaultRun, PodEventFact, FaultFacts } from "./facts.js";
import { FaultGateway } from "./fault-gateway.js";
import { OperationHistory } from "./operation-history.js";
import { FaultWaitError, launchPod, type FaultPod } from "./pod.js";
import type { FaultOrder, FaultWorkflow, PodEvent } from "./pod-protocol.js";
import { StoreOutageMode } from "./store-outage.js";
import { StoreHoldPoint } from "./store-points.js";
import { ExecutionHistoryStatus } from "../../infrastructure/execution-history.repository.js";

/**
 * One scenario's world (#484): its pods on one database — each through a TCP proxy of its own when
 * the database is reached over TCP —, the payment gateway, every pod's events in the order they
 * came, the history of every store operation, and the orders the scenario started. A wait of the
 * world looks at the events of every pod, dead or alive; it is bounded, and past its deadline it
 * fails naming what it waited for.
 */

export class FaultWorld {
  readonly history = new OperationHistory();
  readonly gateway = new FaultGateway();
  readonly events: PodEventFact[] = [];
  readonly orders: { readonly orderId: string; readonly decline: boolean }[] = [];
  readonly pods: FaultPod[] = [];
  /** The scenario's own expectations that did not hold (`expectThat`), checked after the invariants. */
  readonly expectations: string[] = [];
  readonly timeOrigin = systemClock.now().getTime();
  readonly #proxies = new Map<string, DatabaseProxy>();
  readonly #watchers = new Set<() => void>();
  #starts = 0;

  /**
   * How long a wait of the world lasts (real time): the longest a step of a scenario takes is a
   * lease's expiry and the next sweep — 60 s of the pods' clock —, four times over, at least 20 s.
   */
  readonly waitTimeout: Milliseconds;

  constructor(readonly options: FaultWorldOptions) {
    this.waitTimeout = seconds(Math.max(20, 240 / options.timeScale));
  }

  /** Whether the pods reach the database through proxies (a network database). */
  get isProxied(): boolean {
    const { url, proxy } = this.options.database;
    return proxy ?? tcpTargetOf(url) !== undefined;
  }

  /** Starts pod `name` and waits until it is ready. */
  async pod(name: string, options: FaultPodOptions = {}): Promise<FaultPod> {
    const { url } = this.options.database;
    const target = tcpTargetOf(url);
    let databaseUrl = url;
    if (this.isProxied && target !== undefined) {
      const proxy = new DatabaseProxy(target);
      this.#proxies.set(name, proxy);
      databaseUrl = throughProxy(url, await proxy.start());
    }
    const pod = await launchPod({
      name,
      stores: this.options.stores,
      databaseUrl,
      timeScale: this.options.timeScale,
      timeOrigin: this.timeOrigin,
      shutdownTimeout: options.shutdownTimeout,
      maxConcurrentSteps: options.maxConcurrentSteps,
      clockSkew: options.clockSkew,
      onOperation: (event) => {
        this.history.record(event);
        this.#notify();
      },
      onEvent: (from, event) => {
        this.events.push({ ...event, pod: from.name });
        this.#notify();
      },
      onGateway: (from, id, call) => void this.gateway.call(from, id, call),
    });
    this.pods.push(pod);
    return pod;
  }

  /** The proxy between pod `name` and the database; a world without proxies has none. */
  proxyOf(name: string): DatabaseProxy | undefined {
    return this.#proxies.get(name);
  }

  /**
   * Cuts `pod` off its database: through its proxy when it has one — `drop` cuts its connections
   * and refuses new ones, `pause` stalls them —, else its held stores' outage (`Refuse` / `Hang`).
   */
  async cut(pod: FaultPod, how: "drop" | "pause"): Promise<void> {
    const proxy = this.#proxies.get(pod.name);
    if (proxy !== undefined) {
      if (how === "drop") proxy.drop();
      else proxy.pause();
      return;
    }
    const mode = how === "drop" ? StoreOutageMode.Refuse : StoreOutageMode.Hang;
    await pod.command({ op: "outage", mode });
  }

  /** Gives `pod` its database back. */
  async restore(pod: FaultPod): Promise<void> {
    const proxy = this.#proxies.get(pod.name);
    if (proxy !== undefined) proxy.restore();
    else await pod.command({ op: "outage", mode: null });
  }

  /** Starts a tree of `workflow` on `pod` (in the background); its tag, on its `finished` event. */
  async start(
    pod: FaultPod,
    workflow: FaultWorkflow,
    orders: readonly FaultOrder[],
  ): Promise<string> {
    this.#starts += 1;
    const tag = `${pod.name}:${String(this.#starts)}`;
    for (const order of orders)
      this.orders.push({ orderId: order.orderId, decline: order.decline ?? false });
    await pod.command({ op: "start", tag, workflow, orders });
    return tag;
  }

  /** The first event of any pod `matches` accepts, come already or to come; bounded. */
  next(
    what: string,
    matches: (event: PodEventFact) => boolean,
    timeout: Milliseconds = this.waitTimeout,
  ): Promise<PodEventFact> {
    const deadline = new AbortController();
    return new Promise<PodEventFact>((resolve, reject) => {
      const look = (): void => {
        const event = this.events.find(matches);
        if (event === undefined && !deadline.signal.aborted) return;
        this.#watchers.delete(look);
        deadline.abort();
        if (event !== undefined) resolve(event);
        else
          reject(
            new FaultWaitError(
              `no ${what} within ${String(timeout / 1000)} s; events: ${this.#lastEvents()}`,
            ),
          );
      };
      this.#watchers.add(look);
      void systemClock.sleep(timeout, deadline.signal).then(() => {
        if (deadline.signal.aborted) return;
        deadline.abort();
        look();
      });
      look();
    });
  }

  #notify(): void {
    for (const watch of [...this.#watchers]) watch();
  }

  /** Resolves once `condition` holds, looked at on every event and operation; bounded. */
  async until(what: string, condition: () => boolean): Promise<void> {
    await this.next(what, () => condition());
  }

  #lastEvents(): string {
    return JSON.stringify(this.events.slice(-60));
  }

  /** The `nth` event (from 1) `matches` accepts, of any pod; bounded. */
  nth(what: string, matches: (event: PodEventFact) => boolean, nth: number): Promise<PodEventFact> {
    return this.next(
      what,
      (event) => matches(event) && this.events.filter(matches)[nth - 1] === event,
    );
  }

  /** A step of `orderId` reached `point` on any pod (`step` events; `nth` from 1). */
  stepOf(orderId: string, point: string, nth = 1): Promise<PodEventFact> {
    return this.nth(
      `step ${point} of ${orderId} (#${String(nth)})`,
      (event) => event.type === "step" && event.orderId === orderId && event.point === point,
      nth,
    );
  }

  /** The execution `executionId` ended at a finish or failed, on any pod. */
  ended(executionId: string): Promise<PodEventFact> {
    return this.next(
      `end of ${executionId}`,
      (event) =>
        (event.type === "end" || event.type === "failed") && event.executionId === executionId,
    );
  }

  /**
   * Until every root that ended — an `end` or a `failed` of its own — had its kept record saved
   * as ended (the history store's `save`, which comes after the event).
   */
  async #recordsKept(): Promise<void> {
    const ended = this.events.flatMap((event) =>
      (event.type === "end" || event.type === "failed") &&
      event.executionId === event.rootExecutionId
        ? [String(event.executionId)]
        : [],
    );
    const saved = (root: string): boolean =>
      this.history.operations.some(
        ({ invoke, complete }) =>
          invoke.operation === StoreHoldPoint.HistorySave &&
          invoke.key === root &&
          complete?.error === undefined &&
          complete !== undefined &&
          (invoke.input as { status?: string } | undefined)?.status !==
            ExecutionHistoryStatus.Paused,
      );
    await this.until("every ended root's kept record", () => ended.every(saved));
  }

  /** The facts of the run, read by `reader` (a live pod), with what the test kept. */
  async run(reader: FaultPod): Promise<FaultRun> {
    await this.#recordsKept();
    const roots = [...new Set(this.events.flatMap((event) => rootOf(event)))];
    const facts = (await reader.command({ op: "read", rootExecutionIds: roots })) as FaultFacts;
    return {
      ...facts,
      orders: this.orders,
      requests: this.gateway.requests,
      payments: this.gateway.payments,
      events: this.events,
      ...{
        history: this.history,
        timeScale: this.options.storeTimeScale ?? this.options.timeScale,
      },
    };
  }

  /** Kills every pod still running and closes the proxies. */
  async close(): Promise<void> {
    await Promise.all(this.pods.filter((pod) => pod.isRunning).map((pod) => pod.kill()));
    await Promise.all([...this.#proxies.values()].map((proxy) => proxy.close()));
  }
}

/** The root execution an event names, if any. */
const rootOf = (event: PodEvent): string[] =>
  typeof event.rootExecutionId === "string" ? [event.rootExecutionId] : [];
