import type { CostReport } from "../../finops/usage.js";
import type { Environment } from "../../flow/generated-types.js";
import type { Milliseconds } from "../../units/index.js";
import type { VirtualClock } from "../clock.js";
import type { TurnFor } from "../script-types.js";
import type { Override } from "./override.js";
import type { ExecutionContext } from "../../flow/context/execution-context.js";
import type { TenantContext } from "../../flow/context/tenant-context.js";
import type { TestContextOptions } from "../execution-context.js";

/**
 * What every unit runner of `agboss/testing` takes (#262 S55, S62, S89): the component is created
 * by a container of its own — its `deps` resolved, the classes in `overrides` replaced — on an
 * application context with `environment` and a `VirtualClock`; its calls run for the tenant and with
 * the execution values given — `tenantContext` / `tenant`, `executionContext` / `execution`, as
 * `testExecutionContext` takes them, checked by the classes' field decorators — else the default
 * tenant.
 */
export interface UnitOptions<
  TExecution extends ExecutionContext = ExecutionContext,
  TTenant extends TenantContext = TenantContext,
> extends Omit<TestContextOptions<TExecution, TTenant>, "application"> {
  /** Classes replaced by classes: `[override(SearchClient, FakeSearchClient)]`. */
  readonly overrides?: readonly Override[];
  /** The application's environment values (`applicationContext.environment`); default: none. */
  readonly environment?: Environment;
}

/**
 * The scripted answers of a component's model, one turn per model call, in order — typed like
 * `mockLlm(X).thenReturn(…)` (a model router's `routeTo(…)` by its `Route<R>`).
 */
export type UnitModelScript<TSelf = unknown> = TurnFor<TSelf> | readonly TurnFor<TSelf>[];

/** A unit runner's options for a component that calls a model (a judge, a router, an arbiter, …). */
export interface UnitModelOptions<
  TSelf = unknown,
  TExecution extends ExecutionContext = ExecutionContext,
  TTenant extends TenantContext = TenantContext,
> extends UnitOptions<TExecution, TTenant> {
  /** Its model's answers: `decideWith({ grounded: 0.9 })`, `replyWith("PASS")`, `routeTo(X)`. */
  readonly model?: UnitModelScript<TSelf>;
}

/** What one call of a unit runner takes besides its input. */
export interface UnitCallOptions {
  /**
   * The call's `executionContext.signal` aborts after this long on the runner's clock (a tool:
   * its own `timeout` when not given); the call then rejects with the timeout.
   */
  readonly timeout?: Milliseconds;
}

/** What one call of a unit runner gives: the component's output and what the call cost. */
export interface UnitRun<TOutput> {
  readonly output: TOutput;
  /** Its model calls and the services it recorded (`SpendRecorder`), as an execution reports them. */
  readonly spend: CostReport;
}

/** What every unit runner shows besides its calls: the clock its timeouts and waits run on. */
export interface UnitClock {
  /** `await runSearch.clock.advance(seconds(31))`: a timeout or a `waitFor(…)` without real waiting. */
  readonly clock: VirtualClock;
}
