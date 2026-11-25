import type { BuiltApp } from "../app/create-app.js";
import { graphDepsNamed } from "../app/own-deps.js";
import type { AppDeps } from "../app/app-deps.js";
import { listensTo, recipientsOf } from "../app/pause-notices.js";
import type { ListenerHooks, ListenerReceiver } from "../app/pause-notice-receive.js";
import type { PauseNoticeDelivery } from "../app/pause-notice-delivery.js";
import type { Class } from "../components/injection.js";
import { lazyLoad } from "../infrastructure/clock.js";
import type { Infrastructure } from "../infrastructure/contracts.js";
import type { FrameworkLog } from "../infrastructure/logger.js";
import type { PauseRecipients, PauseRecord } from "../infrastructure/pause-record.js";
import type { PauseNotices } from "../pause/types.js";
import { CHANNEL_LISTENER_HOOKS } from "../pause/channel-listener.js";
import type { PauseTally } from "../pause/pause-tally.js";
import type { ChannelSender } from "../channels/channel-sender.js";
import { listenersOf, channelListenerOf } from "../pause/channel-listener.js";
import type { AssembledApplication } from "./assemble.js";

/**
 * Where an application instance's pause notices meet (#940): its listeners, the receivers it knows,
 * the `PauseNotices` every workflow's pause seam is made with (who is told, and the fast path) and
 * the delivery, loaded with the first notice or the first tick. Workflows are built before the
 * hub knows them (`bind`): the seam only reads them when a pause changes.
 */

/** Makes one workflow's notices from its deps (made last: the deps contain the seam). */
export type PauseNoticesFor = (depsOf: () => AppDeps) => PauseNotices;

/** What `application/` and the instance's stop use of the hub. */
export interface PauseNoticeHub {
  readonly noticesFor: PauseNoticesFor;
  /** The instance's interruption: from then on a delivery still running is cut off. */
  readonly interruptedBy: (signal: AbortSignal) => void;
  /** Knows the instance's workflows once they are built. */
  readonly bind: (workflows: readonly BuiltApp[]) => void;
  /**
   * Who is told of a change of a pause (#942: the reminder look writes without a workflow at hand):
   * its channel when that listens, found in whichever workflow of the instance has it, and every listener.
   */
  readonly recipientsOf: (pause: PauseRecord) => PauseRecipients;
  /** Notices were written by the caller: a look for them at once, not awaited, never throws. */
  readonly delivered: () => void;
  /** From now on the pauses the instance changes are counted in `tally` (#943). */
  readonly tallyTo: (tally: PauseTally) => void;
  /** One look for notices due (the timers' look). */
  readonly look: () => Promise<void>;
  /** Resolves when the looks started by the fast path ended (`app.close()` waits for them). */
  readonly settled: () => Promise<void>;
}

/** Every hook a listener may have, each optional. */
const LISTENER_HOOKS = CHANNEL_LISTENER_HOOKS;

const isHandler = (value: unknown): value is ListenerHooks =>
  typeof value === "object" &&
  value !== null &&
  // a `@ChannelListener`'s hooks are optional, its rules check it has one
  LISTENER_HOOKS.some((hook) => typeof Reflect.get(value, hook) === "function");

/** The `channel:<name>` of every channel of the instance that listens to a notice (V11.4). */
const listeningChannels = (workflows: readonly BuiltApp[]): readonly string[] => [
  ...new Set(
    workflows.flatMap((one) =>
      (one.deps.channelNames ?? [])
        .filter((name) => listensTo(one.deps.channelOf?.(name).sender))
        .map((name) => `channel:${name}`),
    ),
  ),
];

/** The sender of a pause's channel in the workflow `deps` has the pause's workflow in; `undefined`: none. */
function senderIn(deps: AppDeps, pause: PauseRecord): ChannelSender | undefined {
  const own = graphDepsNamed(deps, pause.workflow);
  try {
    return pause.channel === undefined ? undefined : own?.channelOf?.(pause.channel).sender;
  } catch {
    // a channel this workflow does not have: nobody to tell
    return undefined;
  }
}

/** The instance's hub over its assembled application and stores. */
export function pauseNoticeHubOf(
  assembled: AssembledApplication,
  infrastructure: Pick<Infrastructure, "pausedExecutions" | "clock">,
  log: FrameworkLog,
): PauseNoticeHub {
  return new Hub(assembled, infrastructure, log);
}

class Hub implements PauseNoticeHub {
  readonly #classes: readonly Class[];
  readonly #names: readonly string[];
  readonly #fast = new Set<Promise<void>>();
  #workflows: readonly BuiltApp[] = [];
  #loading: Promise<PauseNoticeDelivery> | undefined;
  #interruption: AbortSignal | undefined;
  #tally: PauseTally | undefined;

  constructor(
    private readonly assembled: AssembledApplication,
    private readonly infrastructure: Pick<Infrastructure, "pausedExecutions" | "clock">,
    private readonly log: FrameworkLog,
  ) {
    this.#classes = listenersOf(assembled.providers);
    this.#names = this.#classes.flatMap((cls) => channelListenerOf(cls)?.name ?? []);
  }

  interruptedBy(signal: AbortSignal): void {
    this.#interruption = signal;
  }

  tallyTo(tally: PauseTally): void {
    this.#tally = tally;
  }

  bind(workflows: readonly BuiltApp[]): void {
    this.#workflows = workflows;
  }

  async look(): Promise<void> {
    await (await this.#delivery()).look();
  }

  async settled(): Promise<void> {
    await Promise.allSettled([...this.#fast]);
    if (this.#loading !== undefined) await (await this.#loading).settled();
  }

  recipientsOf(pause: PauseRecord): PauseRecipients {
    const sender = this.#workflows.map((one) => senderIn(one.deps, pause)).find(Boolean);
    return recipientsOf({ senderOf: () => sender, listeners: this.#names })(pause);
  }

  delivered(): void {
    this.#kick();
  }

  noticesFor(depsOf: () => AppDeps): PauseNotices {
    const senderOf = (pause: PauseRecord): ChannelSender | undefined => {
      const own = graphDepsNamed(depsOf(), pause.workflow) ?? depsOf();
      try {
        return pause.channel === undefined ? undefined : own.channelOf?.(pause.channel).sender;
      } catch {
        // a channel this workflow does not have: nobody to tell
        return undefined;
      }
    };
    const tallied = (): PauseTally | undefined => this.#tally;
    return {
      // read when a change is applied: the metrics may be attached after the seam is made
      get tally() {
        return tallied();
      },
      recipientsOf: recipientsOf({ senderOf, listeners: this.#names }),
      delivered: () => {
        this.#kick();
      },
    };
  }

  /** A look for the notices just written, at once; kept so `settled` waits for it. */
  #kick(): void {
    const started = this.#delivery()
      .then((one) => {
        one.kick();
      })
      .catch((error: unknown) => {
        const text = `the pause notices could not be looked for: ${String(error)}`;
        this.log.warn("pause-timers.failed", text);
      })
      .finally(() => {
        this.#fast.delete(started);
      });
    this.#fast.add(started);
  }

  #delivery(): Promise<PauseNoticeDelivery> {
    return (this.#loading ??= lazyLoad(import("../app/pause-notice-delivery.js")).then(
      (module) =>
        new module.PauseNoticeDelivery({
          pauses: this.infrastructure.pausedExecutions,
          clock: this.infrastructure.clock,
          interruption: () => this.#interruption,
          log: this.log,
          retention: this.assembled.pauseRecordRetention,
          listenerOf: (name) => this.#listenerOf(name),
          rootOf: (pause) => this.#rootOf(pause),
          recipients: () => [
            ...listeningChannels(this.#workflows),
            ...this.#names.map((name) => `listener:${name}`),
          ],
        }),
    ));
  }

  /** The listener of a name: its one instance, from the first workflow's container. */
  #listenerOf(name: string): ListenerReceiver | undefined {
    const cls = this.#classes.find((one) => channelListenerOf(one)?.name === name);
    const meta = cls === undefined ? undefined : channelListenerOf(cls);
    const [first] = this.#workflows;
    if (cls === undefined || meta === undefined || first === undefined) return undefined;
    const handler: unknown = first.app.resolve(cls);
    return isHandler(handler) ? { handler, includePauseIds: meta.includePauseIds } : undefined;
  }

  /** The deps of the root workflow of a pause: its own, or its thread's (a child's pause). */
  async #rootOf(pause: PauseRecord): Promise<AppDeps | undefined> {
    if (pause.executionId === pause.rootExecutionId)
      return this.#workflows.find((one) => one.deps.config.name === pause.workflow)?.deps;
    for (const one of this.#workflows) {
      const { turns, config } = one.deps;
      if (await turns.hasThread(config.name, pause.tenantId, pause.threadId)) return one.deps;
    }
    return undefined;
  }
}
