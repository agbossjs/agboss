/**
 * #591 — `ExecutionIds`, the one way the framework makes a new execution's id: minted by the
 * generator, kept by the lease store, refused when kept already — the refusal naming the project's
 * own generator class whether or not the framework's check (#578) wraps it; and the ids of a graph
 * run with no application: random, kept nowhere.
 */
import { describe, expect, it } from "vitest";
import { DuplicateExecutionIdError } from "../../src/errors.js";
import {
  CheckedIdGenerator,
  executionIdsOf,
  IdGenerator,
  unkeptExecutionIds,
} from "../../src/infrastructure/clock.js";
import type { ExecutionIdentity } from "../../src/infrastructure/execution-lease.repository.js";

class FixedIdGenerator extends IdGenerator {
  newThreadId(): string {
    return "thread-1";
  }

  newExecutionId(): string {
    return "execution-1";
  }
}

/** A lease store's ids: the identities it was asked to keep, and whether it keeps them. */
function idsStore(isKept: boolean) {
  const asked: ExecutionIdentity[] = [];
  return {
    asked,
    saveExecutionIdIfAbsent: (identity: ExecutionIdentity) => {
      asked.push(identity);
      return Promise.resolve(isKept);
    },
  };
}

describe("#591: ExecutionIds", () => {
  it("a kept id is the generator's, asked for the tenant", async () => {
    const store = idsStore(true);

    const id = await executionIdsOf(new FixedIdGenerator(), store).newExecutionId("acme");

    expect(id).toBe("execution-1");
    expect(store.asked).toEqual([{ executionId: "execution-1", tenantId: "acme" }]);
  });

  it.each([
    ["the project's own generator", new FixedIdGenerator()],
    ["the framework's check around it (#578)", new CheckedIdGenerator(new FixedIdGenerator())],
  ])("a refused id names the project's class, through %s", async (_through, generator) => {
    const refused = executionIdsOf(generator, idsStore(false)).newExecutionId("acme");

    await expect(refused).rejects.toBeInstanceOf(DuplicateExecutionIdError);
    await expect(refused).rejects.toMatchObject({
      code: "run.duplicate-execution-id",
      generator: "FixedIdGenerator",
      details: { generator: "FixedIdGenerator", method: "newExecutionId" },
    });
  });

  it("a graph run with no application gets random ids, a new one each time", async () => {
    const first = await unkeptExecutionIds.newExecutionId("acme");
    const second = await unkeptExecutionIds.newExecutionId("acme");

    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(second).not.toBe(first);
  });
});
