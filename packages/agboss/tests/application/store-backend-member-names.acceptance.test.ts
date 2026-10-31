/**
 * #554 acceptance — a backend named like any member every object has (each own property of
 * `Object.prototype`: `constructor`, `toString`, `__proto__`, `hasOwnProperty`, `valueOf`, …) is only
 * a name: the `[application.store-backend-mismatch]` hint of a fenced-effect or an outbound-call
 * store beside SQLite leases, and of SQLite fencing stores beside leases on it, names no core class
 * and no function — every name, either way round, both contracts.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import type { Class, Provider } from "../../src/components/injection.js";
import { GraphRuleError } from "../../src/graph/rule-error.js";
import { IN_MEMORY_DATABASE } from "../../src/infrastructure/in-memory-database.js";
import { InMemoryExecutionLeaseRepository } from "../../src/infrastructure/execution-lease.repository.js";
import {
  ApplicationContext,
  Clock,
  ExecutionLeaseRepository,
  FencedEffectSettings,
  InMemoryFencedEffectRepository,
  InMemoryOutboundCallRepository,
  Injectable,
  SqliteExecutionLeaseRepository,
  SqliteFencedEffectRepository,
  SqliteOutboundCallRepository,
  StoreClock,
} from "../../src/index.js";
import { storesApplication } from "./fixtures/store-backends.fixture.js";

/** Every member a plain object has without owning it. */
const MEMBER_NAMES = Object.getOwnPropertyNames(Object.prototype);

const named = (base: Class, backend: string, deps: readonly unknown[]): Class => {
  const store = class extends (base as unknown as new (...args: never[]) => object) {
    static readonly backend: string | undefined = backend;
  };
  Object.defineProperty(store, "name", { value: `${base.name}On_${backend}` });
  return Injectable({ deps } as never)(store as never);
};

const effectsOn = (backend: string): Class =>
  named(InMemoryFencedEffectRepository, backend, [
    Clock,
    IN_MEMORY_DATABASE,
    FencedEffectSettings,
    ExecutionLeaseRepository,
  ]);
const callsOn = (backend: string): Class =>
  named(InMemoryOutboundCallRepository, backend, [
    StoreClock,
    IN_MEMORY_DATABASE,
    ExecutionLeaseRepository,
  ]);
const leasesOn = (backend: string): Class =>
  named(InMemoryExecutionLeaseRepository, backend, [Clock, ApplicationContext, IN_MEMORY_DATABASE]);

/** The mismatch messages of assembling `providers`. */
async function mismatchesOf(providers: readonly Provider[]): Promise<readonly string[]> {
  try {
    await applicationOf(storesApplication(providers));
    return [];
  } catch (error) {
    if (!(error instanceof GraphRuleError)) throw error;
    return error.violations
      .filter((found) => found.code === "application.store-backend-mismatch")
      .map((found) => found.message);
  }
}

/** The hint names the member as a backend only, never a class or a function in its place. */
function expectOnlyANameIn(message: string, member: string): void {
  expect(message).toContain(`declaring backend "${member}"`);
  expect(message).not.toContain(`declaring backend "${member}" (`);
  expect(message).not.toMatch(/function|\[native code\]|\[object /u);
}

describe("#554 acceptance: a backend named like an object's member is only a name", () => {
  it("covers the members a plain object has", () => {
    expect(MEMBER_NAMES).toEqual(
      expect.arrayContaining(["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf"]),
    );
  });

  it.each(MEMBER_NAMES)("%s: fencing stores on it beside SQLite leases", async (member) => {
    const found = [
      ...(await mismatchesOf([effectsOn(member), SqliteExecutionLeaseRepository])),
      ...(await mismatchesOf([callsOn(member), SqliteExecutionLeaseRepository])),
    ];

    expect(found).toHaveLength(2);
    for (const message of found) {
      expectOnlyANameIn(message, member);
      expect(message).toMatch(
        /declaring backend "sqlite" \(Sqlite(FencedEffect|OutboundCall)Repository\)/u,
      );
    }
  });

  it.each(MEMBER_NAMES)("%s: SQLite fencing stores beside leases on it", async (member) => {
    const found = [
      ...(await mismatchesOf([SqliteFencedEffectRepository, leasesOn(member)])),
      ...(await mismatchesOf([SqliteOutboundCallRepository, leasesOn(member)])),
    ];

    expect(found).toHaveLength(2);
    for (const message of found) {
      expectOnlyANameIn(message, member);
      expect(message).toContain(
        'lease store declaring backend "sqlite" (SqliteExecutionLeaseRepository)',
      );
    }
  });
});
