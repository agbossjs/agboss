/**
 * #1366: the built-in execution record store answers `ping` with a promise that resolves, and keeps its records in
 * an in-memory SQLite database of the instance — never a file (it is opened on `:memory:`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryExecutionRecordRepository } from "../../src/infrastructure/execution-record.repository.js";
import { RandomIdGenerator } from "../../src/infrastructure/clock.js";
import { VirtualClock } from "../../src/testing/clock.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("#1366: InMemoryExecutionRecordRepository", () => {
  it("answers ping with a promise that resolves to nothing", async () => {
    const repository = new InMemoryExecutionRecordRepository(
      new VirtualClock(),
      new RandomIdGenerator(),
    );

    const answer = repository.ping();

    expect(answer).toBeInstanceOf(Promise);
    await expect(answer).resolves.toBeUndefined();
  });

  it("opens its database on :memory:", () => {
    const real = process.getBuiltinModule.bind(process);
    const opened: unknown[] = [];
    vi.spyOn(process, "getBuiltinModule").mockImplementation((id: string) => {
      const module = real(id as never) as { DatabaseSync: new (...args: never[]) => object };
      if (id !== "node:sqlite") return module;
      return {
        ...module,
        DatabaseSync: class extends module.DatabaseSync {
          constructor(...args: never[]) {
            super(...args);
            opened.push(args[0]);
          }
        },
      };
    });

    new InMemoryExecutionRecordRepository(new VirtualClock(), new RandomIdGenerator());

    expect(opened).toEqual([":memory:"]);
  });
});
