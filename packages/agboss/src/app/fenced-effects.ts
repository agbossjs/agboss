import { markBusinessKeyWriter } from "../components/container/fenced-reach.js";
import { Injectable } from "../components/decorators.js";
import {
  FencedEffectRepository,
  type EffectKey,
  type FencedEffectOutcome,
  type FencedEffectWork,
} from "../infrastructure/fenced-effect.repository.js";

/**
 * The application's fenced effects (#890): a core service a component injects
 * (`deps: [ExecutionContext, FencedEffects]`), over the listed `FencedEffectRepository` — the store
 * is infrastructure, so business code never names one, and a move from SQLite to PostgreSQL is a
 * change of `@Application({ providers })` only.
 */
@Injectable({ deps: [FencedEffectRepository] })
export class FencedEffects {
  constructor(private readonly repository: FencedEffectRepository<unknown>) {}

  /**
   * Runs `work` once per key (`effectKeyOf(executionContext, name)`), in the store's transaction
   * with its result: stored before → its result (`Replayed`, `work` not called); run by this
   * instance now → its outcome (`Joined`); else `work` runs and its result is kept (`Ran`). A
   * zombie's call — its lease taken over — is refused (`ExecutionFencedError`), nothing written.
   * `work` gets the listed store's transaction: a component that writes its own rows in it names
   * its type (`(database: DatabaseSync) => …` on `SqliteFencedEffectRepository`); one that writes
   * none ignores it.
   */
  runOnce<TResult, TTransaction = unknown>(
    key: EffectKey,
    work: FencedEffectWork<TTransaction, TResult>,
  ): Promise<FencedEffectOutcome<TResult>> {
    // the transaction is the listed store's: `TTransaction` is the component's word for it
    return this.repository.runOnce(key, work as FencedEffectWork<unknown, TResult>);
  }
}

// #825: a component that reaches FencedEffects can write under a business key
markBusinessKeyWriter(FencedEffects);

/**
 * What a component gets for `FencedEffects` outside an application's container (#890): `agboss
 * check` builds a workflow's components and never runs them, and a workflow on its own has no
 * infrastructure — every call is refused, since a fenced effect's store is the application's.
 */
export const FENCED_EFFECTS_OUTSIDE_APPLICATION = Object.freeze({
  runOnce: (): Promise<never> =>
    Promise.reject(
      new TypeError(
        "FencedEffects.runOnce: a fenced effect runs in an application (createApp, testWith, a unit runner) — its store is the application's infrastructure",
      ),
    ),
});
