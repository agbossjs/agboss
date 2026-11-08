/**
 * #825 AC1 — the fingerprint decision is checked in the transaction every core store runs, not only
 * at `saveResultIfAbsent`'s entry: a subclass whose entry skips it, and the outbound-call store,
 * refuse a business key without a fingerprint or `FingerprintPolicy.None` before anything is written.
 */
import { describe, expect, it } from "vitest";
import { NO_ENVIRONMENT_VALUES } from "../../src/environments/resolve.js";
import { applicationContextOf } from "../../src/flow/context/application-context.js";
import {
  FingerprintRequiredError,
  InMemoryFencedEffectRepository,
  InMemoryOutboundCallRepository,
  type EffectKey,
  type FencedEffectWork,
} from "../../src/index.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import { FencedEffectSettings } from "../../src/infrastructure/fenced-effect-settings.js";
import type { InMemoryFencedEffectTransaction } from "../../src/infrastructure/in-memory-fenced-effect.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { SqliteExecutionLeaseRepository } from "../../src/infrastructure/sqlite/sqlite-execution-lease.repository.js";
import { SqliteFencedEffectRepository } from "../../src/infrastructure/sqlite/sqlite-fenced-effect.repository.js";
import { SqliteOutboundCallRepository } from "../../src/infrastructure/sqlite/sqlite-outbound-call.repository.js";
import type { DatabaseSync } from "node:sqlite";
import { VirtualClock } from "../../src/testing/clock.js";
import { effectKeyForTesting } from "../../src/testing/contracts/effect-key.js";
import { keyOf } from "../../src/testing/contracts/fenced-effect-data.js";
import { intentOf } from "../../src/testing/contracts/outbound-call-data.js";
import { hours } from "../../src/units/index.js";
import { connectionTo, temporarySqlitePath } from "./contracts/store-kinds.js";
import { storeClockOf } from "../helpers/store-clock.js";

const clock = new VirtualClock();
const application = applicationContextOf({
  ...{ name: "fence-application", version: "1.0.0", instanceId: "instance-1" },
  ...{ startedAt: clock.now(), environmentName: "test", environment: NO_ENVIRONMENT_VALUES },
});

/** A store whose entry skips every check of `saveResultIfAbsent`: straight to its transaction. */
class EntrylessEffects extends InMemoryFencedEffectRepository {
  write<TResult>(key: EffectKey, work: FencedEffectWork<InMemoryFencedEffectTransaction, TResult>) {
    return this.runInTransaction(key, work);
  }
}

/** The same on SQLite. */
class EntrylessSqliteEffects extends SqliteFencedEffectRepository {
  write<TResult>(key: EffectKey, work: FencedEffectWork<DatabaseSync, TResult>) {
    return this.runInTransaction(key, work);
  }
}

const unfingerprinted = (key: EffectKey): EffectKey =>
  effectKeyForTesting(key, { businessKey: "order:42" });

describe("#825 AC1: the fingerprint decision in the stores' own transaction", () => {
  it("in memory: an entry that skips it still refuses, nothing written", async () => {
    const database = new InMemoryDatabase();
    const leases = new InMemoryExecutionLeaseRepository(storeClockOf(clock), application, database);
    const effects = new EntrylessEffects(
      storeClockOf(clock),
      database,
      new FencedEffectSettings(),
      leases,
    );
    const calls = new InMemoryOutboundCallRepository(storeClockOf(clock), database, leases);
    const lease = await leases.acquire("default", "execution-1", hours(1));
    if (lease === undefined) throw new Error("the lease is held");
    const key = unfingerprinted(keyOf(lease));
    let ran = 0;

    await expect(effects.write(key, () => (ran += 1))).rejects.toBeInstanceOf(
      FingerprintRequiredError,
    );
    await expect(calls.saveIfAbsent(key, intentOf(key))).rejects.toBeInstanceOf(
      FingerprintRequiredError,
    );
    expect(ran).toBe(0);
    expect(await calls.findByKey(effectKeyForTesting(key, { fingerprint: "f" }))).toBeUndefined();
  });

  it("on SQLite: the same, nothing written", async () => {
    const connection = connectionTo(temporarySqlitePath());
    const leases = new SqliteExecutionLeaseRepository(connection, storeClockOf(clock), application);
    const effects = new EntrylessSqliteEffects(
      connection,
      storeClockOf(clock),
      new FencedEffectSettings(),
    );
    const calls = new SqliteOutboundCallRepository(connection, storeClockOf(clock));
    const lease = await leases.acquire("default", "execution-1", hours(1));
    if (lease === undefined) throw new Error("the lease is held");
    const key = unfingerprinted(keyOf(lease));
    let ran = 0;

    await expect(effects.write(key, () => (ran += 1))).rejects.toBeInstanceOf(
      FingerprintRequiredError,
    );
    await expect(calls.saveIfAbsent(key, intentOf(key))).rejects.toBeInstanceOf(
      FingerprintRequiredError,
    );
    expect(ran).toBe(0);
    expect(await calls.findByKey(effectKeyForTesting(key, { fingerprint: "f" }))).toBeUndefined();
  });
});
