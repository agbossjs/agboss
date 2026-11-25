import type { Mocked } from "vitest";
import type { Class, Resolved, Token } from "../../components/injection.js";
import { startComponents, stopComponents } from "../../components/container/lifecycle.js";
import type { ExecutionContext } from "../../flow/context/execution-context.js";
import type { TenantContext } from "../../flow/context/tenant-context.js";
import { TestSetupError } from "../errors.js";
import { mockInstanceOf } from "../mocks.js";
import { callTimeoutOf, UnitSite } from "./unit-site.js";
import type { UnitCallOptions, UnitClock, UnitOptions, UnitRun } from "./unit-types.js";

/** One service on its own: its instance, its lifecycle, and what it does in the frame of a step. */
export interface ServiceRunner<TService> extends UnitClock {
  /** The service the container created (its `deps` resolved, the `services` in place of the real ones). */
  readonly service: TService;
  /**
   * `work` in the frame of a step of the default tenant — the injected `ExecutionContext` and
   * `SpendRecorder` read it — its result and what it spent as `{ output, spend }`; `timeout` aborts the
   * call's signal on the runner's clock.
   */
  run<TResult>(
    work: (service: TService) => Promise<TResult> | TResult,
    options?: UnitCallOptions,
  ): Promise<UnitRun<TResult>>;
  /** What the runner's container holds for a token: a class's instance, a token's value, an env's values. */
  get<TToken extends Token>(token: TToken): Resolved<TToken>;
  /**
   * A typed mock in place of a class the service depends on (`mockService(OrderBook).find.mockResolvedValue(…)`):
   * the same instance the service gets. Before the service is first read.
   */
  mockService<T>(component: Class<T>): Mocked<T>;
  /** The lifecycle: `onInit`, `onStart`, `onReady` of every instance the container created, dependencies first. */
  start(): Promise<void>;
  /** The lifecycle: `onStop`, `onBeforeDestroy`, `onDestroy`, dependants first. */
  stop(): Promise<void>;
}

/**
 * A multi-method `@Injectable` service on its own (#1328): a repository, a client of an `@McpServer`
 * or `@A2AAgent`, a listener, an observer. Created by a container of its own — its `deps`, the
 * `services` in place of the real ones, `mockService(Dependency)` — on a `VirtualClock`; its methods
 * are called as the application calls them, its hooks by `start()` / `stop()`.
 */
export function testService<
  TService extends Class,
  TExecution extends ExecutionContext = ExecutionContext,
  TTenant extends TenantContext = TenantContext,
>(
  service: TService,
  options: UnitOptions<TExecution, TTenant> = {},
): ServiceRunner<InstanceType<TService>> {
  const mocks = new Map<Token, unknown>();
  const created: unknown[] = [];
  let site: UnitSite | undefined;
  const siteOf = (): UnitSite => (site ??= new UnitSite(options, { values: mocks, created }));
  const instanceOf = (): InstanceType<TService> =>
    siteOf().instanceOf(service) as InstanceType<TService>;
  return {
    get clock() {
      return siteOf().clock;
    },
    get service() {
      return instanceOf();
    },
    run: (work, call = {}) => {
      const self = instanceOf();
      const frame = {
        component: service,
        caller: `service:${service.name}`,
        ...callTimeoutOf(call.timeout),
      };
      return siteOf().run(frame, async () => work(self));
    },
    get: <TToken extends Token>(token: TToken): Resolved<TToken> =>
      siteOf().container.get(token) as Resolved<TToken>,
    mockService: <T>(component: Class<T>): Mocked<T> => {
      if (site !== undefined)
        throw new TestSetupError({
          message: `mockService(${component.name}) after the service was created`,
        });
      const existing = mocks.get(component);
      if (existing !== undefined) return existing as Mocked<T>;
      const mock = mockInstanceOf(component);
      mocks.set(component, mock);
      return mock;
    },
    start: async () => {
      instanceOf();
      await startComponents(created);
    },
    stop: () => stopComponents(created),
  };
}
