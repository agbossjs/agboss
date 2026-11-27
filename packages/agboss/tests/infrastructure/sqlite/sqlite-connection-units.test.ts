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
import { inRunOnce } from "../../../src/app/idempotency-scope.js";
import { IdempotencyError } from "../../../src/core/error-families/effect-errors.js";
import { StoreError } from "../../../src/core/error-families/store-errors.js";
import { pauseThread } from "../../../src/infrastructure/clock.js";
import { afterFailedCommit } from "../../../src/infrastructure/sqlite/sqlite-outcome.js";
import {
  BUSY_TIMEOUT,
  inImmediateTransaction,
  isSqliteImplementation,
  oneRowChanged,
  openSqliteDatabase,
  requireSqliteTransaction,
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
  const connect = (settings: object | undefined): SqliteConnection =>
    new SqliteConnection(settings as never);

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    [{ kind: "sqlite" }, "Invalid input: expected string, received undefined"],
    [{ kind: "sqlite", path: "" }, "path is empty — a file path, or :memory: in tests"],
  ])(
    "settings that do not name the file (%j) are refused, saying what is missing",
    (settings, why) => {
      expect(() => connect(settings)).toThrow(
        `the SQLite implementations need SqliteDriver's path: string — ${why}`,
      );
    },
  );

  it("no database storage at all is refused, naming the storage to declare", () => {
    expect(() => connect(undefined)).toThrow(
      "the SQLite implementations need the application's @DatabaseStorage({ driver: SqliteDriver({ path }) })",
    );
  });

  it("settings of another driver are refused", () => {
    expect(() => connect({ kind: "postgres" })).toThrow(
      "the SQLite stores are on the database storage's postgres driver, not SqliteDriver",
    );
  });

  it("names its file, answers a ping while open and refuses it once closed", async () => {
    const connection = connect({ kind: "sqlite", path: ":memory:" });

    expect(connection.path).toBe(":memory:");
    await expect(connection.ping()).resolves.toBeUndefined();
    connection.onDestroy();
    await expect(connection.ping()).rejects.toThrow();
  });

  it("closes the file once when its instance stops, and a second stop is none", () => {
    const connection = connect({ kind: "sqlite", path: ":memory:" });

    connection.onDestroy();

    expect(connection.database.isOpen).toBe(false);
    expect(() => {
      connection.onDestroy();
    }).not.toThrow();
  });

  it("names the columns of a table, and none for a table the file lacks", () => {
    const connection = connect({ kind: "sqlite", path: ":memory:" });
    connection.database.exec("CREATE TABLE notes (text TEXT NOT NULL);");

    expect(connection.columnsOf("notes")).toEqual(["text"]);
    expect(connection.columnsOf("absent")).toEqual([]);
  });

  it("runs work in a transaction of its own", () => {
    const connection = connect({ kind: "sqlite", path: ":memory:" });
    connection.database.exec("CREATE TABLE notes (text TEXT NOT NULL);");

    connection.transaction(() => {
      connection.database.prepare("INSERT INTO notes VALUES (?)").run("kept");
    });

    expect(connection.database.prepare("SELECT text FROM notes").all()).toEqual([{ text: "kept" }]);
  });

  it("a row of a table the file has with a name that is no text is refused, not passed on", () => {
    const connection = connect({ kind: "sqlite", path: ":memory:" });
    vi.spyOn(connection.database, "prepare").mockImplementation((() => ({
      all: () => [{ name: 5 }],
    })) as never);

    expect(() => connection.columnsOf("notes")).toThrow();
  });
});

/** A real in-memory database that also lists the statements `exec` ran, and can be made to fail one. */
class RecordingDatabase extends DatabaseSync {
  static made: RecordingDatabase[] = [];
  static failing = new Map<string, Error>();
  readonly statements: string[] = [];
  closed = 0;
  constructor(_path: string, options: unknown) {
    super(":memory:", options as never);
    RecordingDatabase.made.push(this);
  }
  override exec(sql: string): void {
    this.statements.push(sql);
    const failure = RecordingDatabase.failing.get(sql);
    if (failure !== undefined) {
      RecordingDatabase.failing.delete(sql);
      throw failure;
    }
    super.exec(sql);
  }
  override close(): void {
    this.closed += 1;
    if (this.isOpen) super.close();
  }
}

/** The connections made from here on run over `RecordingDatabase`. */
function recordingDatabases(): void {
  vi.restoreAllMocks();
  RecordingDatabase.made = [];
  RecordingDatabase.failing = new Map();
  vi.spyOn(process, "getBuiltinModule").mockImplementation((name: string) =>
    name === "node:sqlite" ? { DatabaseSync: RecordingDatabase } : real(name),
  );
}

const OUTSIDE =
  "requireTransaction() was called outside an Idempotency.runOnce: a repository takes the effect's transaction only inside `execute`";

const failureOf = (work: () => unknown): unknown => {
  try {
    work();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("#1317c: the transaction of a runOnce, as the connection hands it out", () => {
  const memory = () => new SqliteConnection({ kind: "sqlite", path: ":memory:" } as never);

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("outside a runOnce the connection is in no transaction and has none to give: OutsideTransaction, saying where it may be asked", () => {
    const connection = memory();

    const error = failureOf(() => connection.requireTransaction());

    expect(connection.isInTransaction).toBe(false);
    expect(error).toBeInstanceOf(IdempotencyError.OutsideTransaction);
    expect((error as Error).message).toBe(OUTSIDE);
  });

  it("inside a runOnce of a store that has no SQLite transaction the refusal names that runOnce", () => {
    const connection = memory();

    const error = inRunOnce("charge", () => failureOf(() => connection.requireTransaction()));

    expect(error).toBeInstanceOf(IdempotencyError.OutsideTransaction);
    expect((error as Error).message).toBe(
      'requireTransaction() was called inside runOnce "charge", which runs on a store that has no SQLite transaction (an in-memory fenced-effect store): list SqliteFencedEffectRepository, or test the repository on SQLite',
    );
  });

  it("inside its own hold the connection is in a transaction and gives the hold's handle, on its own and as the ambient one", async () => {
    const connection = memory();

    const seen = await connection.held((handle) => ({
      handle,
      isInside: connection.isInTransaction,
      own: connection.requireTransaction(),
      ambient: requireSqliteTransaction(),
    }));

    expect(seen.isInside).toBe(true);
    expect(seen.own).toBe(seen.handle);
    expect(seen.ambient).toBe(seen.handle);
    expect(connection.isInTransaction).toBe(false);
  });

  it("the ambient transaction outside a hold is refused, saying it is the SQLite one that is missing", () => {
    const error = failureOf(() => requireSqliteTransaction());

    expect(error).toBeInstanceOf(IdempotencyError.OutsideTransaction);
    expect((error as Error).message).toBe(
      "requireSqliteTransaction() was called outside an Idempotency.runOnce on SQLite: a repository takes the effect's transaction only inside `execute`",
    );
  });

  it("a transaction of its own inside a hold is refused: the effect has one, written through requireTransaction()", async () => {
    const connection = memory();

    const error = await connection.held(() => failureOf(() => connection.transaction(() => 1)));

    expect(error).toBeInstanceOf(IdempotencyError.NestedTransaction);
    expect((error as Error).message).toBe(
      "connection.transaction() was called inside an Idempotency.runOnce: the effect already has its transaction — write through requireTransaction(), so an uncaught error rolls everything back",
    );
  });
});

describe("#1317c: a transaction of the connection and the operation it is inside of", () => {
  beforeEach(recordingDatabases);

  const faked = (): { connection: SqliteConnection; statements: string[] } => {
    const connection = new SqliteConnection({ kind: "sqlite", path: ":memory:" } as never);
    const statements = RecordingDatabase.made.at(-1)?.statements ?? [];
    statements.length = 0;
    return { connection, statements };
  };

  it("outside an operation it takes the write lock first and commits: BEGIN IMMEDIATE, the work, COMMIT", () => {
    const { connection, statements } = faked();

    expect(connection.transaction(() => 5)).toBe(5);

    expect(statements).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
  });

  it("inside an operation that has written it joins the operation's transaction as a savepoint, and a failure undoes only its own statements", async () => {
    const real = new SqliteConnection({ kind: "sqlite", path: ":memory:" } as never);
    const { database } = real;
    database.exec("CREATE TABLE notes (text TEXT NOT NULL)");

    await real.serve(() => {
      database.exec("INSERT INTO notes VALUES ('before')");
      expect(() =>
        real.transaction(() => {
          database.exec("INSERT INTO notes VALUES ('inside')");
          throw new Error("the inner work failed");
        }),
      ).toThrow("the inner work failed");
      real.transaction(() => {
        database.exec("INSERT INTO notes VALUES ('after')");
      });
    });

    expect(database.prepare("SELECT text FROM notes ORDER BY rowid").all()).toEqual([
      { text: "before" },
      { text: "after" },
    ]);
  });

  it("the savepoint is named and released around the work, never a transaction of its own", () => {
    const { connection, statements } = faked();
    connection.database.exec("CREATE TABLE notes (text TEXT NOT NULL)");
    statements.length = 0;

    void connection.gate(() => {
      connection.database.exec("INSERT INTO notes VALUES ('a')");
      connection.transaction(() => undefined);
    });

    expect(statements).toEqual([
      "BEGIN IMMEDIATE",
      "INSERT INTO notes VALUES ('a')",
      "SAVEPOINT agboss_nested",
      "RELEASE agboss_nested",
      "COMMIT",
    ]);
  });

  it("an operation called from inside another is part of its attempt: its result is its own, its busy answer the outer one's", async () => {
    const connection = new SqliteConnection({ kind: "sqlite", path: ":memory:" } as never);
    let outer = 0;
    let inner = 0;
    const busyOnce = Object.assign(new Error("database is locked"), { errcode: 5 });

    const result = await connection.gate(() => {
      outer += 1;
      return connection.gate(() => {
        inner += 1;
        if (inner === 1) throw busyOnce;
        return "inner result";
      });
    });

    expect(result).toBe("inner result");
    // the retry was the outer operation's, whole: it called the inner one again
    expect(outer).toBe(2);
    expect(inner).toBe(2);
  });

  it("a nested operation's result is returned as it is, without a tick when the file is free", () => {
    const connection = new SqliteConnection({ kind: "sqlite", path: ":memory:" } as never);

    const result = connection.gate(() => connection.gate(() => 7));

    expect(result).toBe(7);
  });
});

describe("#1317c: the operations served ahead of a hold, and the renewals that survive its rollback", () => {
  const memory = () => new SqliteConnection({ kind: "sqlite", path: ":memory:" } as never);
  const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("a priority operation runs inside the open hold at once; an ordinary one waits until the hold ends", async () => {
    const connection = memory();
    let release: () => void = () => undefined;
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const hold = connection.held(async () => {
      await open;
      order.push("hold ends");
    });
    await turn();

    const ahead = connection.serve(() => order.push("priority"), { isPriority: true });
    const behind = connection.serve(() => order.push("ordinary"));
    await ahead;
    await turn();
    expect(order).toEqual(["priority"]);
    release();
    await hold;
    await behind;

    expect(order).toEqual(["priority", "hold ends", "ordinary"]);
  });

  it.each([
    [true, ["renewed"]],
    [false, []],
    [undefined, []],
  ])(
    "a priority write of renewal %s that rode in a hold which rolled back is re-applied: %j stays",
    async (isRenewal, kept) => {
      const connection = memory();
      connection.database.exec("CREATE TABLE rows (row TEXT)");
      const options = isRenewal === undefined ? { isPriority: true } : { isPriority: true, isRenewal };

      await expect(
        connection.held(async () => {
          await turn();
          await connection.serve(() => connection.database.exec("INSERT INTO rows VALUES ('renewed')"), options);
          throw new Error("a declined card");
        }),
      ).rejects.toThrow("a declined card");
      await turn();

      expect(
        connection.database.prepare("SELECT row FROM rows").all().map((found) => found.row),
      ).toEqual(kept);
    },
  );
});

describe("#1317: the work of a startup, and the schema an application's repository makes", () => {
  beforeEach(recordingDatabases);

  const faked = (): { connection: SqliteConnection; statements: string[] } => {
    const connection = new SqliteConnection({ kind: "sqlite", path: ":memory:" } as never);
    const statements = RecordingDatabase.made.at(-1)?.statements ?? [];
    statements.length = 0;
    return { connection, statements };
  };

  it("waits for the file's lock for the window and not after: the busy timeout, the work, the busy timeout back to 0", () => {
    const { connection, statements } = faked();

    const result = connection.startupWork(() => {
      statements.push("work");
      return 9;
    }, 250);
    connection.startupWork(() => undefined);

    expect(result).toBe(9);
    expect(statements).toEqual([
      "PRAGMA busy_timeout = 250",
      "work",
      "PRAGMA busy_timeout = 0",
      `PRAGMA busy_timeout = ${String(BUSY_TIMEOUT)}`,
      "PRAGMA busy_timeout = 0",
    ]);
  });

  it("a failure of the work is thrown as it is and the wait is still given back", () => {
    const { connection, statements } = faked();
    const failure = new Error("the DDL failed");

    const error = failureOf(() =>
      connection.startupWork(() => {
        throw failure;
      }, 250),
    );

    expect(error).toBe(failure);
    expect(statements).toEqual(["PRAGMA busy_timeout = 250", "PRAGMA busy_timeout = 0"]);
  });

  it("a lock held past the window is StoreError.LockTimeout, nothing applied, the wait given back", () => {
    const { connection, statements } = faked();
    const busy5 = Object.assign(new Error("database is locked"), { errcode: 5 });

    const error = failureOf(() =>
      connection.startupWork(() => {
        throw busy5;
      }, 250),
    );

    expect(error).toBeInstanceOf(StoreError.LockTimeout);
    expect((error as Error).message).toBe(
      "the SQLite file stayed locked by another process for 250 ms: nothing was applied, the call can be tried again",
    );
    expect((error as Error).cause).toBe(busy5);
    expect(statements.at(-1)).toBe("PRAGMA busy_timeout = 0");
  });

  it("an application's DDL runs once per name, in a transaction of its own", () => {
    const { connection, statements } = faked();

    connection.ensureSchema("notes", "CREATE TABLE IF NOT EXISTS notes (text TEXT)");
    connection.ensureSchema("notes", "CREATE TABLE IF NOT EXISTS notes (text TEXT)");
    connection.ensureSchema("memos", "CREATE TABLE IF NOT EXISTS memos (text TEXT)");

    expect(statements.filter((sql) => sql.includes("CREATE TABLE"))).toEqual([
      "CREATE TABLE IF NOT EXISTS notes (text TEXT)",
      "CREATE TABLE IF NOT EXISTS memos (text TEXT)",
    ]);
    expect(statements.slice(0, 5)).toEqual([
      "PRAGMA busy_timeout = 5000",
      "BEGIN IMMEDIATE",
      "CREATE TABLE IF NOT EXISTS notes (text TEXT)",
      "COMMIT",
      "PRAGMA busy_timeout = 0",
    ]);
  });

  it("a failure of the schema at the open closes the file and is thrown as it is", () => {
    const failure = new Error("the schema could not be made");
    RecordingDatabase.failing.set("PRAGMA busy_timeout = 0", failure);

    const error = failureOf(() => new SqliteConnection({ kind: "sqlite", path: ":memory:" } as never));

    expect(error).toBe(failure);
    expect(RecordingDatabase.made.at(-1)?.closed).toBe(1);
  });
});

describe("#1317c: the SQLite implementations' operations meet their instance's connection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("an operation of an instance that holds a connection in a field is gated by it; an instance with none runs as it is", () => {
    class Gated {
      constructor(readonly connection: unknown) {}
      read(): string {
        return "read";
      }
    }
    sqliteImplementation(Gated);
    const connection = new SqliteConnection({ kind: "sqlite", path: ":memory:" } as never);
    const gate = vi.spyOn(connection, "gate");

    expect(new Gated(connection).read()).toBe("read");
    expect(gate).toHaveBeenCalledOnce();
    expect(new Gated({ not: "a connection" }).read()).toBe("read");
    expect(new Gated(undefined).read()).toBe("read");
    expect(gate).toHaveBeenCalledOnce();
  });

  it("the connection is found among the fields wherever it is, and a field that is another object's is not one", () => {
    class Late {
      readonly note = { kind: "note" };
      constructor(readonly connection: unknown) {}
      read(): string {
        return "read";
      }
    }
    sqliteImplementation(Late);
    const connection = new SqliteConnection({ kind: "sqlite", path: ":memory:" } as never);
    const gate = vi.spyOn(connection, "gate");

    new Late(connection).read();

    expect(gate).toHaveBeenCalledOnce();
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
