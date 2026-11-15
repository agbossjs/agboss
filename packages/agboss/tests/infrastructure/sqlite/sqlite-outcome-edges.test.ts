/**
 * #1069 — the edges of #1017's classification that the mutation shard `store-bound` found
 * unproved: which values carry a SQLite code, a COMMIT that fails with no transaction left, a
 * ROLLBACK that fails too, the operation a single write is named by, and what the database's and a
 * statement's proxies hand back untouched (only `exec`, and `run` of a statement from `prepare`).
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { StoreOutcomeSource, StoreOutcomeUnknownError } from "../../../src/index.js";
import {
  afterFailedCommit,
  classifiedDatabase,
  sqliteCodeOf,
} from "../../../src/infrastructure/sqlite/sqlite-outcome.js";

const failure = (errcode: number): Error =>
  Object.assign(new Error(`code ${String(errcode)}`), { errcode });
const IOERR = 10;
const BUSY = 5;
const FULL = 13;

/** The database a test hands to a proxy: only what the proxy reads. */
const fake = (members: object): DatabaseSync => {
  const database: DatabaseSync = Object.assign(Object.create(null), members);
  return database;
};

describe("#1069: the code of an error", () => {
  it("is the primary code of an Error with a numeric errcode", () => {
    expect(sqliteCodeOf(failure(1034))).toBe(IOERR);
    expect(sqliteCodeOf(failure(IOERR))).toBe(IOERR);
  });

  it("is none for what is not an Error, has no errcode or has one that is no number", () => {
    expect(sqliteCodeOf({ errcode: 1034 })).toBeUndefined();
    expect(sqliteCodeOf(new Error("plain"))).toBeUndefined();
    expect(sqliteCodeOf(Object.assign(new Error("text"), { errcode: "5" }))).toBeUndefined();
    expect(sqliteCodeOf(null)).toBeUndefined();
    expect(sqliteCodeOf("text")).toBeUndefined();
  });
});

describe("#1069: a failed COMMIT, the transaction already gone", () => {
  it("is of unknown outcome with the commit's own error as its cause, no rollback tried", () => {
    const rolledBack: string[] = [];
    const error = failure(FULL);

    const outcome = afterFailedCommit(
      fake({ isTransaction: false, exec: (sql: string) => void rolledBack.push(sql) }),
      error,
    );

    expect(rolledBack).toEqual([]);
    expect(outcome).toBeInstanceOf(StoreOutcomeUnknownError);
    expect((outcome as StoreOutcomeUnknownError).cause).toBe(error);
  });
});

describe("#1069: a ROLLBACK that fails after a failed COMMIT", () => {
  const rollbackError = new Error("the connection is closed");
  const broken = fake({
    isTransaction: true,
    exec: () => {
      throw rollbackError;
    },
  });

  it("leaves the outcome unknown, with both errors", () => {
    const error = failure(IOERR);

    const outcome = afterFailedCommit(broken, error) as StoreOutcomeUnknownError;

    expect(outcome).toBeInstanceOf(StoreOutcomeUnknownError);
    expect(outcome.operation).toBe("COMMIT");
    expect(outcome.store).toBe("SqliteConnection");
    expect(outcome.source).toBe(StoreOutcomeSource.Transport);
    const aggregate = outcome.cause as AggregateError;
    expect(aggregate).toBeInstanceOf(AggregateError);
    expect(aggregate.message).toBe("COMMIT and ROLLBACK failed");
    expect(aggregate.errors).toEqual([error, rollbackError]);
  });

  it("is the commit's own error when SQLite said the transaction stays open", () => {
    const error = failure(BUSY);

    expect(afterFailedCommit(broken, error)).toBe(error);
  });
});

describe("#1069: a single write outside a transaction", () => {
  const statementOf = (run: () => unknown, extra: Record<string, unknown> = {}) => ({
    run,
    all: run,
    ...extra,
  });

  it("an I/O error of `exec` is of unknown outcome, named `write`", () => {
    const error = failure(1034);
    const database = classifiedDatabase(
      fake({
        isTransaction: false,
        exec: () => {
          throw error;
        },
      }),
    );

    let thrown: unknown;
    try {
      database.exec("INSERT INTO notes VALUES ('a')");
    } catch (caught) {
      thrown = caught;
    }

    expect(thrown).toBeInstanceOf(StoreOutcomeUnknownError);
    expect((thrown as StoreOutcomeUnknownError).operation).toBe("write");
    expect((thrown as StoreOutcomeUnknownError).cause).toBe(error);
  });

  it("another error of `exec` is its own, and one inside a transaction too", () => {
    const refusal = failure(19);
    const ioError = failure(IOERR);
    const outside = classifiedDatabase(
      fake({
        isTransaction: false,
        exec: () => {
          throw refusal;
        },
      }),
    );
    const inside = classifiedDatabase(
      fake({
        isTransaction: true,
        exec: () => {
          throw ioError;
        },
      }),
    );

    expect(() => {
      outside.exec("x");
    }).toThrow(refusal);
    expect(() => {
      inside.exec("x");
    }).toThrow(ioError);
  });

  it("the `run` of a prepared statement is classified, any other method of it is not", () => {
    const error = failure(IOERR);
    const throwing = () => {
      throw error;
    };
    const database = classifiedDatabase(
      fake({ isTransaction: false, prepare: () => statementOf(throwing) }),
    );
    const statement = database.prepare("x");

    expect(() => statement.run()).toThrow(StoreOutcomeUnknownError);
    expect(() => statement.all()).toThrow(error);
    expect(() => statement.all()).not.toThrow(StoreOutcomeUnknownError);
  });

  it("the `run` of a statement inside a transaction is its own error", () => {
    const error = failure(IOERR);
    const database = classifiedDatabase(
      fake({
        isTransaction: true,
        prepare: () =>
          statementOf(() => {
            throw error;
          }),
      }),
    );

    expect(() => database.prepare("x").run()).toThrow(error);
  });

  it("a member of a statement that is no function is read as it is", () => {
    const database = classifiedDatabase(
      fake({
        isTransaction: false,
        prepare: () => statementOf(() => undefined, { sourceSQL: "x" }),
      }),
    );

    expect(database.prepare("x").sourceSQL).toBe("x");
  });
});

describe("#1069: what the database's proxy leaves as it is", () => {
  it("a member that is no function", () => {
    const database = classifiedDatabase(fake({ isTransaction: false, isOpen: true }));

    expect(database.isOpen).toBe(true);
  });

  it.each([null, undefined, "text", 5])(
    "what `prepare` returns that is not a statement object: %s",
    (value) => {
      const database = classifiedDatabase(fake({ prepare: () => value }));

      expect(database.prepare("x") as unknown).toBe(value);
    },
  );

  it("what a method other than `prepare` returns, object or not", () => {
    const object = { run: () => undefined };
    const database = classifiedDatabase(
      fake({ createSession: () => object, location: () => null }),
    );

    expect(database.createSession()).toBe(object);
    expect(database.location()).toBeNull();
  });
});
