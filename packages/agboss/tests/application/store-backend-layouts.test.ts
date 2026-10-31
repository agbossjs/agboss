/**
 * #526 AC1 — the layouts the backend check is for, and its opt-out. Coordination stores of a
 * Redis layout (leases, rate limits, the child queue) on "redis", the lease log anywhere: it
 * assembles; a fenced-effect or outbound-call store is refused there unless it is on "redis" too or
 * declares `LeaseCheck.WithoutDoubleChargeProtection` — which is not checked, and warns
 * `[application.lease-check-not-atomic]` at the start (`app.warnings`, `agboss check`, an error
 * under `--strict`), naming the store and the guarantee it gives up.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { createApp } from "../../src/application/create-app.js";
import { Application } from "../../src/application/application.js";
import { assemblyWarningsOf } from "../../src/application/start-log.js";
import type { Provider } from "../../src/components/injection.js";
import { applicationWarningsOf } from "../../src/describe/application.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import { IN_MEMORY_DATABASE } from "../../src/infrastructure/in-memory-database.js";
import {
  ApplicationContext,
  Clock,
  EmptyEnvironment,
  Injectable,
  LogLevel,
  SqliteExecutionLeaseEventRepository,
} from "../../src/index.js";
import { ScriptBook } from "../../src/testing/script-book.js";
import { createScriptedGateway } from "../../src/testing/scripted-gateway.js";
import { InMemoryChildExecutionQueueRepository } from "../../src/infrastructure/child-execution-queue.repository.js";
import { InMemoryRateLimitRepository } from "../../src/infrastructure/rate-limit.repository.js";
import { logged, RecordingLogger, resetLogged } from "../helpers/log.js";
import { ReleaseWorkflow } from "../app/fixtures/fence.workflow.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import {
  PostgresCalls,
  PostgresEffects,
  PostgresLeases,
  RedisCalls,
  RedisEffects,
  RedisLeases,
  storesApplication,
  UncheckedCalls,
  UncheckedEffects,
  UncheckedRedisEffects,
} from "./fixtures/store-backends.fixture.js";

@Injectable({ deps: [Clock, ApplicationContext, IN_MEMORY_DATABASE] })
class RedisRateLimits extends InMemoryRateLimitRepository {}

@Injectable({ deps: [Clock, ApplicationContext, IN_MEMORY_DATABASE] })
class RedisChildQueue extends InMemoryChildExecutionQueueRepository {}

/** The coordination stores of a Redis layout; the lease log on another backend. */
const REDIS_LAYOUT: readonly Provider[] = [
  RedisLeases,
  RedisRateLimits,
  RedisChildQueue,
  SqliteExecutionLeaseEventRepository,
];

async function codesOf(providers: readonly Provider[]): Promise<readonly string[]> {
  try {
    await applicationOf(storesApplication(providers));
    return [];
  } catch (error) {
    if (!(error instanceof GraphRuleError)) throw error;
    return error.violations.map((found) => found.code);
  }
}

const NOT_ATOMIC = "application.lease-check-not-atomic";

const notAtomicText = (store: string): string =>
  `[${NOT_ATOMIC}] ${store} declares LeaseCheck.WithoutDoubleChargeProtection: it checks the lease outside its write's transaction, so a holder whose lease was taken over can still write — no protection against a double charge or a second owner's write; it passes no fencing case of storeConformance and must never back payments (Wiki → Your-own-store#an-opted-out-store-and-storeconformance-543)`;

describe("#526 AC1: a Redis layout — coordination stores on Redis", () => {
  it("leases, rate limits and the queue on Redis, the lease log on SQLite: it assembles", async () => {
    expect(await codesOf(REDIS_LAYOUT)).toEqual([]);
  });

  it("a fenced-effect store on PostgreSQL beside it is refused", async () => {
    expect(await codesOf([...REDIS_LAYOUT, PostgresEffects])).toEqual([
      "application.store-backend-mismatch",
    ]);
  });

  it("an outbound-call store on PostgreSQL beside it is refused", async () => {
    expect(await codesOf([...REDIS_LAYOUT, PostgresCalls])).toEqual([
      "application.store-backend-mismatch",
    ]);
  });

  it("both on PostgreSQL: both refused, at once", async () => {
    expect(await codesOf([...REDIS_LAYOUT, PostgresEffects, PostgresCalls])).toEqual([
      "application.store-backend-mismatch",
      "application.store-backend-mismatch",
    ]);
  });

  it("both on Redis too: it assembles", async () => {
    expect(await codesOf([...REDIS_LAYOUT, RedisEffects, RedisCalls])).toEqual([]);
  });

  it("both opting out: it assembles, and each one warns", async () => {
    const assembled = await applicationOf(
      storesApplication([...REDIS_LAYOUT, UncheckedEffects, UncheckedCalls]),
    );

    const warnings = assemblyWarningsOf(assembled).filter(({ code }) => code === NOT_ATOMIC);
    expect(warnings.map(({ code, message }) => `[${code}] ${message}`)).toEqual([
      notAtomicText("UncheckedEffects"),
      notAtomicText("UncheckedCalls"),
    ]);
  });

  it("the same stores on PostgreSQL, the lease log anywhere: it assembles", async () => {
    expect(
      await codesOf([
        PostgresLeases,
        PostgresEffects,
        PostgresCalls,
        SqliteExecutionLeaseEventRepository,
      ]),
    ).toEqual([]);
  });
});

describe("#526 AC1: the opt-out, LeaseCheck.WithoutDoubleChargeProtection", () => {
  it("an opted-out store is not compared with the lease store, declared or not", async () => {
    expect(await codesOf([UncheckedEffects, PostgresLeases])).toEqual([]);
    expect(await codesOf([UncheckedRedisEffects, PostgresLeases])).toEqual([]);
    expect(await codesOf([UncheckedCalls])).toEqual([]);
  });

  it("the other fencing store is still checked", async () => {
    expect(await codesOf([UncheckedEffects, RedisCalls, PostgresLeases])).toEqual([
      "application.store-backend-mismatch",
    ]);
  });

  it("agboss check reads the warning from the declaration (an error under --strict)", async () => {
    const assembled = await applicationOf(storesApplication([UncheckedRedisEffects, RedisLeases]));

    expect(applicationWarningsOf(assembled).map(({ code }) => code)).toContain(NOT_ATOMIC);
  });

  it("no opt-out, no warning", async () => {
    const assembled = await applicationOf(storesApplication([RedisEffects, RedisLeases]));

    expect(applicationWarningsOf(assembled).map(({ code }) => code)).not.toContain(NOT_ATOMIC);
  });

  it("an instance lists it in app.warnings and logs it, with the guarantee it gives up", async () => {
    resetLogged();
    @Application({
      name: "unchecked-application",
      version: "1.0.0",
      environment: EmptyEnvironment,
      workflows: [ReleaseWorkflow],
      budgets: TEST_BUDGETS,
      providers: [UncheckedEffects, RecordingLogger],
    })
    class UncheckedApplication {}

    const app = await createApp(UncheckedApplication, {
      processEnv: {},
      gateway: createScriptedGateway(new ScriptBook()),
    });
    await app.close();

    expect(app.warnings).toContain(notAtomicText("UncheckedEffects"));
    expect(
      logged.filter((entry) => entry.level === LogLevel.Warn).map((entry) => entry.message),
    ).toContain(notAtomicText("UncheckedEffects"));
  });
});
