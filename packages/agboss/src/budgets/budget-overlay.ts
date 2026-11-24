import type { Class } from "../components/injection.js";
import { recordComponent } from "../components/metadata.js";
import type { EnvRef } from "../environments/env-ref.js";
import type { Usd } from "../units/index.js";
import { budgetOf } from "./budget.js";

/**
 * What a profile (`src/config/<name>.config.ts|yaml`, `budgets: { "name-budget": { … } }`) changes of
 * one `@Budget`'s declared limits (#1318c): the dollar cap and the token cap, constants or `defineEnv`
 * values. Only a budget that declares its limits in the decorator takes one — a `limit()` reads its
 * own.
 */
export interface BudgetOverlay {
  readonly maxSpend?: Usd | EnvRef<Usd>;
  readonly maxTokens?: number | EnvRef<number>;
}

/** The overlays of the selected profiles by budget `name`, later profiles already folded in. */
export type BudgetOverlays = ReadonlyMap<string, BudgetOverlay>;

/** What the assembly passes to every reader of an application's budgets, so each sees the same limits. */
export interface OverlaidBudgets {
  readonly budgetOverlays?: BudgetOverlays | undefined;
}

/** A class and what a profile made of it: one derived class per (class, overlay), made once. */
const derived = new WeakMap<Class, WeakMap<BudgetOverlay, Class>>();
/** The classes this module derived: overlaid once, never again. */
const overlaid = new WeakSet<Class>();

/**
 * The budget as the selected profiles leave it: the class itself when no profile names it, else a
 * subclass whose `@Budget` record carries the overlaid limits — the declared class and its record are
 * never changed, so two applications under two profiles never see each other's limits. The same class
 * and overlay always give the same derived class, so a list that holds it twice still holds one.
 */
export function overlaidBudget(cls: Class, overlays: BudgetOverlays | undefined): Class {
  if (overlaid.has(cls)) return cls;
  const meta = budgetOf(cls);
  const overlay = meta === undefined ? undefined : overlays?.get(meta.name);
  if (meta === undefined || overlay === undefined) return cls;
  const known = derived.get(cls)?.get(overlay);
  if (known !== undefined) return known;
  const subclass = class extends (cls as new (...args: never[]) => object) {};
  Object.defineProperty(subclass, "name", { value: cls.name });
  recordComponent(subclass, { kind: "budget", meta: { ...meta, ...overlay } });
  const byOverlay = derived.get(cls) ?? new WeakMap<BudgetOverlay, Class>();
  byOverlay.set(overlay, subclass);
  derived.set(cls, byOverlay);
  overlaid.add(subclass);
  return subclass;
}
