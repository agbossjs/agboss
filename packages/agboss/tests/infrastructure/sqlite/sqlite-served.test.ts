/**
 * #1317, bug hunt 2026-11-25 finding 1, the runtime half of the guard: a statement of a gated SQLite
 * operation that runs after one of its awaits outside `connection.serve` fails at once, every time —
 * not only when a `runOnce` hold happens to open in the gap — and served again it runs.
 */
import { describe, expect, it } from "vitest";
import {
  type SqliteConnection,
  sqliteImplementation,
} from "../../../src/infrastructure/sqlite/sqlite-connection.js";
import { connectionTo, temporarySqlitePath } from "../contracts/store-kinds.js";

class Probe {
  constructor(readonly connection: SqliteConnection) {}

  async unserved(): Promise<unknown> {
    await Promise.resolve();
    return this.connection.database.prepare("SELECT 1 AS one").get();
  }

  async served(): Promise<unknown> {
    await Promise.resolve();
    return this.connection.serve(() => this.connection.database.prepare("SELECT 1 AS one").get());
  }

  async *stream(): AsyncGenerator {
    yield this.connection.database.prepare("SELECT 1 AS one").get();
  }

  async *servedStream(): AsyncGenerator {
    yield await this.connection.serve(() =>
      this.connection.database.prepare("SELECT 1 AS one").get(),
    );
  }
}
sqliteImplementation(Probe);

const UNSERVED = /ran after an await of it, outside connection\.serve/;

describe("#1317: no statement of an operation after its await runs outside connection.serve", () => {
  it("one after an await fails with no hold open, served again it runs", async () => {
    const probe = new Probe(connectionTo(temporarySqlitePath()));

    await expect(probe.unserved()).rejects.toThrow(UNSERVED);
    await expect(probe.served()).resolves.toEqual({ one: 1 });
  });

  it("a stream's body is never covered by the gate: its statements are served", async () => {
    const probe = new Probe(connectionTo(temporarySqlitePath()));
    const read = async (stream: AsyncGenerator): Promise<unknown[]> => {
      const rows: unknown[] = [];
      for await (const row of stream) rows.push(row);
      return rows;
    };

    await expect(read(probe.stream())).rejects.toThrow(UNSERVED);
    await expect(read(probe.servedStream())).resolves.toEqual([{ one: 1 }]);
  });

  it("a statement outside any operation (a test, start-up) is not refused", () => {
    const connection = connectionTo(temporarySqlitePath());

    expect(connection.database.prepare("SELECT 1 AS one").get()).toEqual({ one: 1 });
  });
});
