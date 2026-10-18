import { ComponentError } from "../metadata.js";

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

/** Closing connections, releasing resources. A failure does not stop the other hooks. */
export interface OnDestroy {
  /** Runs once the running executions have finished or paused (dependants first). */
  onDestroy(): Promise<void> | void;
}

type HookName = "onInit" | "onStart" | "onStop" | "onDestroy";

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
const hookFailure = (instance: object, hook: HookName, error: unknown): ComponentError =>
  new ComponentError(
    `[di.hook-failed] ${componentName(instance)}.${hook} failed: ${messageOf(error)}`,
    { cause: error },
  );

/** Runs `hook` of every instance in order; the first failure stops it, naming the component and the hook. */
async function runInOrder(
  instances: readonly unknown[],
  hook: "onInit" | "onStart",
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

/** Runs `hook` of every instance, dependants first; every hook runs, the failures are returned. */
async function runAll(
  instances: readonly unknown[],
  hook: "onStop" | "onDestroy",
): Promise<ComponentError[]> {
  const failures: ComponentError[] = [];
  for (const instance of [...instances].reverse()) {
    if (!hasHook(instance, hook)) continue;
    try {
      await instance[hook]();
    } catch (error) {
      failures.push(hookFailure(instance, hook, error));
    }
  }
  return failures;
}

/** The failures of the stop hooks as one error, or nothing when every hook ran through. */
const collected = (failures: readonly ComponentError[]): AggregateError | undefined =>
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
  } catch (error) {
    await runAll(initialized, "onDestroy");
    throw error;
  }
}

/**
 * The stop of an application instance: `onStop` of every instance (dependants first), then
 * `executionsDone` (the running executions finish or pause), then `onDestroy` (dependants first).
 * Every hook runs; the failures are collected into one `AggregateError`.
 */
export async function stopComponents(
  instances: readonly unknown[],
  executionsDone: () => Promise<void> = () => Promise.resolve(),
): Promise<void> {
  const stopped = await runAll(instances, "onStop");
  await executionsDone();
  const destroyed = await runAll(instances, "onDestroy");
  const failure = collected([...stopped, ...destroyed]);
  if (failure !== undefined) throw failure;
}
