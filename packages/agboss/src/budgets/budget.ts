import { recordOptionKeys } from "../components/option-keys.js";
import { BUDGET_KEYS } from "../components/decorator-options.js";
import type { Class, ResolvedAll, Token } from "../components/injection.js";
import { componentOf, recordComponent } from "../components/metadata.js";
import type { EnvRef } from "../environments/env-ref.js";
import type { BudgetLimit } from "../infrastructure/cost-ledger.repository.js";
import type { Usd } from "../units/index.js";

/**
 * Money limits are `@Budget` components (#261): one template for every budget — the decorator says
 * what it limits, `maxSpend()` how much. Every budget of the application is listed in
 * `@Application({ budgets })`, written in `config/budget.config.ts`. This PR declares them; the
 * checks before the first step and after every model call come with the runtime budgets.
 */

/** What a budget limits. */
export enum BudgetScope {
  /** One full pass of `app.execute`, with everything it triggers: the unit-economics cost cap. */
  Execution = "execution",
  /** One organization (the `tenantId`) per period. */
  Tenant = "tenant",
  /** The whole application per period. */
  Application = "application",
}

/** The period of a tenant or application budget (UTC). */
export enum BudgetPeriod {
  Day = "day",
  Week = "week",
  Month = "month",
}

/** What a budget limits by: dollars or tokens (#1318); the unit of the limit an execution hit. */
export enum BudgetUnit {
  Usd = "usd",
  Tokens = "tokens",
}

/**
 * A budget's limits, read once per execution, at its start, from a trusted source (#1318): a
 * dollar cap, a token cap, or both — the first reached stops the execution. A class with
 * `maxSpend` / `maxTokens` in `@Budget({ … })` needs no handler; one that reads them from a service
 * writes `limit()` (and `deps`).
 */
export interface BudgetHandler {
  /** The limits, read at the start of each execution. */
  readonly limit?: () => BudgetLimit | Promise<BudgetLimit>;
  /** The dollar cap of a handler written before `limit()`; read once per execution. */
  readonly maxSpend?: () => Usd | Promise<Usd>;
}

/** What `@Budget` takes of the limits: declared in the decorator (constants or `defineEnv` values). */
export interface DeclaredLimits {
  /** The most the budget lets be spent, in dollars; a `defineEnv` value (`env.usd`) is read at the start. */
  readonly maxSpend?: Usd | EnvRef<Usd>;
  /** The most tokens (input plus output) the budget lets be used; `env.integer` is read at the start. */
  readonly maxTokens?: number | EnvRef<number>;
}

/**
 * The cost of one execution: its own workflow's (`workflow: X`, at most one per workflow), or the
 * default for every root without its own (no `workflow`). No period.
 */
export interface ExecutionBudgetOptions<TDeps extends readonly Token[]> extends DeclaredLimits {
  /** Ends with `-budget` (`tenant-daily-budget`). */
  readonly name: string;
  /** What the budget is for: shown by `agboss describe`. */
  readonly description?: string;
  readonly deps?: TDeps;
  readonly scope: BudgetScope.Execution;
  readonly workflow?: Class;
  readonly period?: never;
}

/** A tenant's or the application's spend per period; no `workflow`. */
export interface PeriodBudgetOptions<TDeps extends readonly Token[]> extends DeclaredLimits {
  /** Ends with `-budget` (`tenant-daily-budget`). */
  readonly name: string;
  /** What the budget is for: shown by `agboss describe`. */
  readonly description?: string;
  readonly deps?: TDeps;
  readonly scope: BudgetScope.Tenant | BudgetScope.Application;
  readonly period: BudgetPeriod;
  readonly workflow?: never;
}

/** `@Budget` options, discriminated by `scope`. */
export type BudgetOptions<TDeps extends readonly Token[] = readonly Token[]> =
  ExecutionBudgetOptions<TDeps> | PeriodBudgetOptions<TDeps>;

/** What `@Budget` records about a class. */
export interface BudgetMeta {
  readonly name: string;
  readonly description?: string;
  /** The limits declared in the decorator: absent when the class reads them in `limit()`. */
  readonly maxSpend?: Usd | EnvRef<Usd>;
  readonly maxTokens?: number | EnvRef<number>;
  readonly scope: BudgetScope;
  readonly period?: BudgetPeriod;
  readonly workflow?: Class;
  readonly deps: readonly Token[];
}

/**
 * A budget: `@Budget({ name, scope, period?, workflow?, deps? })` on a class that
 * `implements BudgetHandler`; its data come through the constructor like any component's.
 */
export function Budget<const TDeps extends readonly Token[] = []>(options: BudgetOptions<TDeps>) {
  return <TClass extends new (...args: ResolvedAll<TDeps>) => BudgetHandler>(
    value: TClass,
  ): TClass => {
    recordOptionKeys(value, "Budget", options, BUDGET_KEYS);
    const { name, scope, period, workflow, description, maxSpend, maxTokens } = options;
    recordComponent(value, {
      kind: "budget",
      meta: {
        name,
        scope,
        deps: options.deps ?? [],
        ...(description === undefined ? {} : { description }),
        ...(maxSpend === undefined ? {} : { maxSpend }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
        ...(period === undefined ? {} : { period }),
        ...(workflow === undefined ? {} : { workflow }),
      },
    });
    return value;
  };
}

/** What `@Budget` recorded on a class; `undefined` when it is not a budget. */
export function budgetOf(cls: Class | undefined): BudgetMeta | undefined {
  // no class, no record: the registry answers `undefined` for a key it has not
  const component = componentOf(cls as object);
  return component?.kind === "budget" ? component.meta : undefined;
}
