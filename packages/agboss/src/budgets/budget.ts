import type { Class, ResolvedAll, Token } from "../components/injection.js";
import { componentOf, recordComponent } from "../components/metadata.js";
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

/** A budget's amount: read once per execution, at its start, from a trusted source. */
export interface BudgetHandler {
  readonly maxSpend: () => Usd | Promise<Usd>;
}

interface BudgetCommonOptions<TDeps extends readonly Token[]> {
  /** Ends with `-budget` (`tenant-daily-budget`). */
  readonly name: string;
  readonly deps?: TDeps;
}

/**
 * The cost of one execution: its own workflow's (`workflow: X`, at most one per workflow), or the
 * default for every root without its own (no `workflow`). No period.
 */
export interface ExecutionBudgetOptions<
  TDeps extends readonly Token[],
> extends BudgetCommonOptions<TDeps> {
  readonly scope: BudgetScope.Execution;
  readonly workflow?: Class;
  readonly period?: never;
}

/** A tenant's or the application's spend per period; no `workflow`. */
export interface PeriodBudgetOptions<
  TDeps extends readonly Token[],
> extends BudgetCommonOptions<TDeps> {
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
    const { name, scope, period, workflow } = options;
    recordComponent(value, {
      kind: "budget",
      meta: {
        name,
        scope,
        deps: options.deps ?? [],
        ...(period === undefined ? {} : { period }),
        ...(workflow === undefined ? {} : { workflow }),
      },
    });
    return value;
  };
}

/** What `@Budget` recorded on a class; `undefined` when it is not a budget. */
export function budgetOf(cls: Class): BudgetMeta | undefined {
  const component = componentOf(cls);
  return component?.kind === "budget" ? component.meta : undefined;
}
