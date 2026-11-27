import { ConfigError } from "../../core/error-families/config-errors.js";

/**
 * The four lifecycle hooks (#261), per application instance, of every component the container
 * creates (services, repositories, providers, tools, handlers, guardrails, observers), each optional.
 * Values (`provide(TOKEN, value)`) and test mocks have none.
 *
 * | hook        | when                                                                          |
 * | ----------- | ----------------------------------------------------------------------------- |
 * | `onInit`    | created, its dependencies injected and past their own `onInit`                |
 * | `onStart`   | every component past `onInit`: the app is ready, no `execute` yet             |
 * | `onStop`    | `app.close()`: no new executions are accepted, running ones go on             |
 * | `onDestroy` | the running executions have finished or paused; dependants first              |
 */

/** Opening its own: a connection, a pool, a cache warm-up. A failure stops the start. */
export interface OnInit {
  /** Runs once the component and its dependencies are created (dependencies first). */
  onInit(): Promise<void> | void;
}

/** What needs the whole application: a check, a log line, a background poll. A failure stops the start. */
export interface OnStart {
  /** Runs once every component is past `onInit`, before the first execution. */
  onStart(): Promise<void> | void;
}

/** Stop taking work, finish its own operations. A failure does not stop the other hooks. */
export interface OnStop {
  /** Runs at `app.close()`: no new executions are accepted, running ones go on. */
  onStop(): Promise<void> | void;
}

/**
 * What needs the whole application (#1324: `onStart`'s name in 0.1.1): runs once every component is
 * past `onInit`, before the first execution. A failure stops the start.
 */
export interface OnReady {
  onReady(): Promise<void> | void;
}

/**
 * Stop taking work, finish its own operations (#1324: `onStop`'s name in 0.1.1): runs at
 * `app.close()`. A failure does not stop the other hooks.
 */
export interface OnBeforeDestroy {
  onBeforeDestroy(): Promise<void> | void;
}

/** Closing connections, releasing resources. A failure does not stop the other hooks. */
export interface OnDestroy {
  /** Runs once the running executions have finished or paused (dependants first). */
  onDestroy(): Promise<void> | void;
}

/**
 * A connection's last resort at the stop (#954): called at once, synchronously, when the stop's end
 * passed with its `onDestroy` still running — the stop abandons that hook and returns, so a socket
 * an orderly close still holds is destroyed here. Not called when `onDestroy` returned in time. A
 * throw is dropped. Store-author surface (`@agboss/core/stores`).
 */
export interface OnAbandon {
  onAbandon(): void;
}

type HookName = "onInit" | "onStart" | "onReady" | "onStop" | "onBeforeDestroy" | "onDestroy";

const hasHook = <THook extends HookName>(
  instance: unknown,
  hook: THook,
): instance is Record<THook, () => Promise<void> | void> =>
  typeof instance === "object" &&
  instance !== null &&
  typeof Reflect.get(instance, hook) === "function";

const componentName = (instance: object): string =>
  instance.constructor.name || "(anonymous class)";

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** A hook that threw, as an error naming the component and the hook (the original as `cause`). */
const hookFailure = (instance: object, hook: HookName, error: unknown): ConfigError.Component =>
  new ConfigError.Component({
    message: `[di.hook-failed] ${componentName(instance)}.${hook} failed: ${messageOf(error)}`,
    cause: error,
  });

/** Runs `hook` of every instance in order; the first failure stops it, naming the component and the hook. */
async function runInOrder(
  instances: readonly unknown[],
  hook: "onInit" | "onStart" | "onReady",
  done: unknown[],
): Promise<void> {
  for (const instance of instances) {
    if (hasHook(instance, hook)) {
      try {
        await instance[hook]();
      } catch (error) {
        throw hookFailure(instance, hook, error);
      }
    }
    done.push(instance);
  }
}

/**
 * The end of a stop (#923): once `signal` aborts, a hook that has not returned is given up — left
 * running, its late answer or failure dropped — and `abandon` is told which.
 */
export interface StopBound {
  readonly signal: AbortSignal;
  abandon(what: string): void;
}

/** Whose hook `withinBound` bounds, and which instances `onAbandon` already ran for (once each). */
export interface BoundedHook {
  readonly hook: HookName;
  readonly instance: object;
  readonly told: WeakSet<object>;
}

/**
 * `work`, or — once `bound` ends first — nothing: `abandon`ed, its late failure dropped. Only an
 * abandoned `onDestroy` calls its instance's `onAbandon`, at most once per instance (#954).
 */
export async function withinBound(
  work: Promise<void>,
  bound: StopBound,
  of: BoundedHook,
): Promise<void> {
  const what = `${of.hook} of ${componentName(of.instance)}`;
  let release = (): void => undefined;
  const ended = new Promise<boolean>((resolve) => {
    // a hook that is done by the next turn of the loop is not abandoned
    const fire = (): void => {
      setImmediate(() => {
        resolve(true);
      });
    };
    if (bound.signal.aborted) fire();
    else {
      bound.signal.addEventListener("abort", fire, { once: true });
      release = () => {
        bound.signal.removeEventListener("abort", fire);
      };
    }
  });
  try {
    const abandoned = await Promise.race([work.then(() => false), ended]);
    if (!abandoned) return;
    work.catch((): undefined => undefined);
    bound.abandon(what);
    if (of.hook === "onDestroy" && !of.told.has(of.instance)) {
      of.told.add(of.instance);
      abandonedBy(of.instance);
    }
  } finally {
    release();
  }
}

/** The instance's `onAbandon`, when it has one: best effort, a throw dropped (#954). */
function abandonedBy(instance: object): void {
  const hook: unknown = Reflect.get(instance, "onAbandon");
  if (typeof hook !== "function") return;
  try {
    Reflect.apply(hook, instance, []);
  } catch {
    // the stop has ended: nothing is left to tell
  }
}

/** Runs `hook` of every instance, dependants first; every hook runs, the failures are returned. */
async function runAll(
  instances: readonly unknown[],
  hook: "onStop" | "onBeforeDestroy" | "onDestroy",
  bound?: StopBound,
): Promise<ConfigError.Component[]> {
  const failures: ConfigError.Component[] = [];
  const told = new WeakSet<object>();
  for (const instance of [...instances].reverse()) {
    if (!hasHook(instance, hook)) continue;
    try {
      const running = Promise.resolve(instance[hook]());
      if (bound === undefined) await running;
      else await withinBound(running, bound, { hook, instance, told });
    } catch (error) {
      failures.push(hookFailure(instance, hook, error));
    }
  }
  return failures;
}

/** The failures of the stop hooks as one error, or nothing when every hook ran through. */
const collected = (failures: readonly ConfigError.Component[]): AggregateError | undefined =>
  failures.length === 0
    ? undefined
    : new AggregateError(
        failures,
        `${String(failures.length)} lifecycle hook(s) failed: ${failures.map((failure) => failure.message).join("; ")}`,
      );

/**
 * The start of an application instance: `onInit` of every instance in creation order (dependencies
 * first), then `onStart` of every one. A failing hook stops the start — the error names the
 * component and the hook — and the instances already past `onInit` get `onDestroy` (dependants first).
 */
export async function startComponents(instances: readonly unknown[]): Promise<void> {
  const initialized: unknown[] = [];
  try {
    await runInOrder(instances, "onInit", initialized);
    await runInOrder(instances, "onStart", []);
    await runInOrder(instances, "onReady", []);
  } catch (error) {
    await runAll(initialized, "onDestroy");
    throw error;
  }
}

/**
 * The stop of an application instance: `onStop` of every instance (dependants first), then
 * `executionsDone` (the running executions finish or pause), then `onDestroy` (dependants first).
 * Every hook runs; the failures are collected into one `AggregateError`. With a `bound` (#923) an
 * `onDestroy` that has not returned at its end is given up: the stop goes on without it.
 */
export async function stopComponents(
  instances: readonly unknown[],
  executionsDone: () => Promise<void> = () => Promise.resolve(),
  bound?: StopBound,
): Promise<void> {
  const stopped = [
    ...(await runAll(instances, "onStop")),
    ...(await runAll(instances, "onBeforeDestroy")),
  ];
  await executionsDone();
  const destroyed = await runAll(instances, "onDestroy", bound);
  const failure = collected([...stopped, ...destroyed]);
  if (failure !== undefined) throw failure;
}
