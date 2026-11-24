/**
 * #1366 (cancel-stores shard) — the SQLite connection on its own, each rule over a fake or an in-memory file: the open
 * (its folder made for a file only, the pragmas in order, the WAL switch tried again while SQLite answers busy — with
 * a doubling pause up to 50 ms, the whole bounded by the busy timeout — and a failure of the open closing the file),
 * the transaction (rolled back only when one is open), the environment's `sqlitePath`, the schema helpers and
 * the marks of a SQLite implementation.
 */
import { mkdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pauseThread } from "../../../src/infrastructure/clock.js";
import { afterFailedCommit } from "../../../src/infrastructure/sqlite/sqlite-outcome.js";
import {
  BUSY_TIMEOUT,
  inImmediateTransaction,
  isSqliteImplementation,
  oneRowChanged,
  openSqliteDatabase,
  SqliteConnection,
  sqliteImplementation,
} from "../../../src/infrastructure/sqlite/sqlite-connection.js";

vi.mock("node:fs", async (original) => {
  const real = await original<typeof import("node:fs")>();
  return { ...real, mkdirSync: vi.fn() };
});
vi.mock("../../../src/infrastructure/sqlite/sqlite-outcome.js", async (original) => ({
  ...(await original<typeof import("../../../src/infrastructure/sqlite/sqlite-outcome.js")>()),
  afterFailedCommit: vi.fn(),
}));
vi.mock("../../../src/infrastructure/clock.js", async (original) => ({
  ...(await original<typeof import("../../../src/infrastructure/clock.js")>()),
  pauseThread: vi.fn(),
}));

const busy = (errcode: number): Error =>
  Object.assign(new Error("database is locked"), { errcode });

/** A database whose `exec` is scripted: what each statement does, in the order it is asked. */
class FakeDatabase extends DatabaseSync {
  static made: FakeDatabase[] = [];
  readonly statements: string[] = [];
  closed = 0;
  constructor(
    readonly path: string,
    readonly options: unknown,
  ) {
    super(":memory:");
    FakeDatabase.made.push(this);
  }
  static behaviour = new Map<string, (() => void)[]>();
  /** Leaves a transaction open on the real in-memory file under it: `isTransaction` is then true. */
  openTransaction(): void {
    super.exec("BEGIN");
  }
  override exec(sql: string): void {
    this.statements.push(sql);
    FakeDatabase.behaviour.get(sql)?.shift()?.();
  }
  override close(): void {
    this.closed += 1;
    if (this.isOpen) super.close();
  }
}

/** The fake a `DatabaseSync` the code under test got is (it opens through the mocked module). */
const fakeOf = (database: DatabaseSync): FakeDatabase => {
  if (!(database instanceof FakeDatabase)) throw new TypeError("not the fake database");
  return database;
};

const walFails = (...errors: unknown[]): void => {
  FakeDatabase.behaviour.set(
    "PRAGMA journal_mode = WAL",
    errors.map((error) => () => {
      throw error;
    }),
  );
};

let real: typeof process.getBuiltinModule;

beforeEach(() => {
  vi.mocked(mkdirSync).mockClear();
  vi.mocked(afterFailedCommit).mockReset();
  FakeDatabase.made = [];
  FakeDatabase.behaviour = new Map();
  vi.mocked(pauseThread).mockReset();
  real = process.getBuiltinModule.bind(process);
  vi.spyOn(process, "getBuiltinModule").mockImplementation((name: string) =>
    name === "node:sqlite" ? { DatabaseSync: FakeDatabase } : real(name),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

const pauses = (): number[] => vi.mocked(pauseThread).mock.calls.map(([delay]) => delay);

describe("#1366: the open of a database", () => {
  it("is on the path with no wait of SQLite's own, its pragmas in order, the busy timeout last: the default one's, or the one given", () => {
    const database = fakeOf(openSqliteDatabase(":memory:"));
    openSqliteDatabase(":memory:", 250);

    expect(database.path).toBe(":memory:");
    expect(database.options).toEqual({ timeout: 0 });
    expect(database.statements).toEqual([
      "PRAGMA foreign_keys = ON",
      "PRAGMA journal_mode = WAL",
      `PRAGMA busy_timeout = ${String(BUSY_TIMEOUT)}`,
    ]);
    expect(FakeDatabase.made[1]?.statements.at(-1)).toBe("PRAGMA busy_timeout = 250");
    expect(BUSY_TIMEOUT).toBe(5000);
  });

  it("makes the folder of a file, with its parents, and none for a database in memory", () => {
    openSqliteDatabase(":memory:");
    expect(mkdirSync).not.toHaveBeenCalled();

    openSqliteDatabase(join("var", "data", "app.sqlite"));

    expect(mkdirSync).toHaveBeenCalledExactlyOnceWith(join("var", "data"), { recursive: true });
    expect(dirname(join("var", "data", "app.sqlite"))).toBe(join("var", "data"));
  });

  it("a WAL switch SQLite answers busy to is tried again after pauses that double, up to the busy timeout, and then fails as it did", () => {
    const final = busy(5);
    walFails(...Array.from({ length: 8 }, () => busy(5)).slice(0, 7), final);

    expect(() => openSqliteDatabase(":memory:", 100)).toThrow(final);

    expect(pauses()).toEqual([1, 2, 4, 8, 16, 32, 37]);
    expect(FakeDatabase.made[0]?.closed).toBe(1);
  });

  it("the pauses never pass 50 ms, and the last is cut to what is left of the timeout", () => {
    walFails(...Array.from({ length: 12 }, () => busy(5)));

    expect(() => openSqliteDatabase(":memory:", 300)).toThrow();

    expect(pauses()).toEqual([1, 2, 4, 8, 16, 32, 50, 50, 50, 50, 37]);
    expect(pauses().reduce((sum, pause) => sum + pause, 0)).toBe(300);
  });

  it("a busy answer that goes away lets the open finish, with the pauses it took", () => {
    walFails(busy(5), busy(261), busy(5));

    const database = fakeOf(openSqliteDatabase(":memory:", 5000));

    expect(pauses()).toEqual([1, 2, 4]);
    expect(database.statements.filter((sql) => sql === "PRAGMA journal_mode = WAL")).toHaveLength(
      4,
    );
    expect(database.statements.at(-1)).toBe("PRAGMA busy_timeout = 5000");
    expect(database.closed).toBe(0);
  });

  it.each([
    ["an extended busy code", 261, true],
    ["a code of another kind (locked)", 6, false],
    ["a code whose low byte is another kind (an extended one of 4)", 260, false],
    ["no error code", undefined, false],
  ])("%s: %s", (_why, errcode, retried) => {
    const error = errcode === undefined ? new Error("boom") : busy(errcode);
    walFails(error);

    const open = () => openSqliteDatabase(":memory:", 10);
    if (retried) {
      expect(open).not.toThrow();
      expect(pauses()).toEqual([1]);
    } else {
      expect(open).toThrow(error);
      expect(pauses()).toEqual([]);
    }
  });

  it.each([
    ["an error code that is no number", Object.assign(new Error("x"), { errcode: "5" })],
    ["a value that is no error", { errcode: 5 }],
    ["a text", "locked"],
  ])("%s is thrown at once, with no pause, and the database closed", (_why, thrown) => {
    walFails(thrown);

    expect(() => openSqliteDatabase(":memory:", 5000)).toThrow();

    expect(pauses()).toEqual([]);
    expect(FakeDatabase.made[0]?.closed).toBe(1);
  });

  it("a failure of any pragma closes the database and is thrown as it is", () => {
    for (const sql of ["PRAGMA foreign_keys = ON", "PRAGMA busy_timeout = 5000"]) {
      const error = new Error(`${sql} failed`);
      FakeDatabase.behaviour.set(sql, [
        () => {
          throw error;
        },
      ]);

      expect(() => openSqliteDatabase(":memory:")).toThrow(error);
      expect(FakeDatabase.made.at(-1)?.closed).toBe(1);
    }
  });
});

describe("#1366: a transaction", () => {
  const databaseOf = () => new FakeDatabase(":memory:", {});

  it("takes the write lock first, runs the work, commits, and is the work's result", () => {
    const database = databaseOf();

    const result = inImmediateTransaction(database, () => 42);

    expect(result).toBe(42);
    expect(database.statements).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
  });

  it("a failed COMMIT is thrown as what the database's own outcome makes of it", () => {
    const database = databaseOf();
    const failure = new Error("disk full");
    const made = new Error("outcome unknown");
    vi.mocked(afterFailedCommit).mockReturnValue(made);
    FakeDatabase.behaviour.set("COMMIT", [
      () => {
        throw failure;
      },
    ]);

    expect(() => inImmediateTransaction(database, () => 1)).toThrow(made);

    expect(afterFailedCommit).toHaveBeenCalledExactlyOnceWith(database, failure);
  });

  it("is rolled back when the work throws while one is open, and the work's error is thrown", () => {
    const database = databaseOf();
    database.openTransaction();
    const error = new Error("work failed");

    expect(() =>
      inImmediateTransaction(database, () => {
        throw error;
      }),
    ).toThrow(error);

    expect(database.statements).toEqual(["BEGIN IMMEDIATE", "ROLLBACK"]);
  });

  it("is not rolled back when SQLite has none open any more", () => {
    const database = databaseOf();

    expect(() =>
      inImmediateTransaction(database, () => {
        throw new Error("work failed");
      }),
    ).toThrow("work failed");

    expect(database.statements).toEqual(["BEGIN IMMEDIATE"]);
  });
});

describe("#1366: the connection of an instance", () => {
  const connect = (environment: object): SqliteConnection =>
    new SqliteConnection({ environment } as never);

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [{}, "Invalid input: expected string, received undefined"],
    [{ sqlitePath: "" }, "sqlitePath is empty — a file path, or :memory: in tests"],
  ])(
    "an environment that does not name the file (%j) is refused, saying what is missing",
    (environment, why) => {
      expect(() => connect(environment)).toThrow(
        `the SQLite implementations need sqlitePath: string in the environment — ${why}; set it in the environment's file, or in a unit test pass it: testAction(X, { environment: { sqlitePath: ":memory:" } })`,
      );
    },
  );

  it("names its file, answers a ping while open and refuses it once closed", async () => {
    const connection = connect({ sqlitePath: ":memory:" });

    expect(connection.path).toBe(":memory:");
    await expect(connection.ping()).resolves.toBeUndefined();
    connection.onDestroy();
    await expect(connection.ping()).rejects.toThrow();
  });

  it("closes the file once when its instance stops, and a second stop is none", () => {
    const connection = connect({ sqlitePath: ":memory:" });

    connection.onDestroy();

    expect(connection.database.isOpen).toBe(false);
    expect(() => {
      connection.onDestroy();
    }).not.toThrow();
  });

  it("names the columns of a table, and none for a table the file lacks", () => {
    const connection = connect({ sqlitePath: ":memory:" });
    connection.database.exec("CREATE TABLE notes (text TEXT NOT NULL);");

    expect(connection.columnsOf("notes")).toEqual(["text"]);
    expect(connection.columnsOf("absent")).toEqual([]);
  });

  it("runs work in a transaction of its own", () => {
    const connection = connect({ sqlitePath: ":memory:" });
    connection.database.exec("CREATE TABLE notes (text TEXT NOT NULL);");

    connection.transaction(() => {
      connection.database.prepare("INSERT INTO notes VALUES (?)").run("kept");
    });

    expect(connection.database.prepare("SELECT text FROM notes").all()).toEqual([{ text: "kept" }]);
  });

  it("a row of a table the file has with a name that is no text is refused, not passed on", () => {
    const connection = connect({ sqlitePath: ":memory:" });
    vi.spyOn(connection.database, "prepare").mockImplementation((() => ({
      all: () => [{ name: 5 }],
    })) as never);

    expect(() => connection.columnsOf("notes")).toThrow();
  });
});

describe("#1366: the SQLite implementations", () => {
  class Store {
    readonly kind = "store";
  }
  class OwnStore extends Store {}
  class Other {
    readonly kind = "other";
  }

  it("an instance of a class marked as one, or of its subclass, is of one; any other instance is not", () => {
    expect(isSqliteImplementation(new Store())).toBe(false);

    sqliteImplementation(Store);

    expect(isSqliteImplementation(new Store())).toBe(true);
    expect(isSqliteImplementation(new OwnStore())).toBe(true);
    expect(isSqliteImplementation(new Other())).toBe(false);
    expect(isSqliteImplementation({})).toBe(false);
    expect(isSqliteImplementation(Object.create(null) as object)).toBe(false);
  });
});

describe("#1366: a write that changes one row", () => {
  it("is true for one row, whether counted as a number or a bigint", () => {
    expect(oneRowChanged(1)).toBe(true);
    expect(oneRowChanged(1n)).toBe(true);
  });

  it.each([0, 2, 0n, 3n])(
    "is an error for %s: the write of a row read first changes one",
    (changes) => {
      expect(() => oneRowChanged(changes)).toThrow(
        new Error(`unreachable: ${String(changes)} rows changed by a write of a row read first`),
      );
    },
  );
});
