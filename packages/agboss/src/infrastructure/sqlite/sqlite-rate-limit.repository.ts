import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Injectable } from "../../components/decorators.js";
import type { Milliseconds } from "../../units/index.js";
import { ApplicationContext } from "../../flow/context/application-context.js";
import { Clock } from "../clock.js";
import { RateLimitRepository, type RateLimitLease } from "../rate-limit.repository.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";

const SCHEMA = `CREATE TABLE IF NOT EXISTS rate_limit_slots (
  slot_id TEXT PRIMARY KEY, slot_key TEXT NOT NULL, holder_instance_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS rate_limit_slots_key ON rate_limit_slots(slot_key, expires_at);`;

/**
 * The windows and pauses (#266 S58, #265 S52), added to a file an older version wrote: a migration
 * by `CREATE TABLE IF NOT EXISTS` — the slots' table is left as it is.
 */
const WINDOWS_SCHEMA = `CREATE TABLE IF NOT EXISTS rate_limit_window_entries (
  window_key TEXT NOT NULL, counted_at INTEGER NOT NULL, amount REAL NOT NULL);
CREATE INDEX IF NOT EXISTS rate_limit_window_entries_key
  ON rate_limit_window_entries(window_key, counted_at);
CREATE TABLE IF NOT EXISTS rate_limit_pauses (
  pause_key TEXT PRIMARY KEY, paused_until INTEGER NOT NULL);`;

const Count = z.object({ taken: z.number() });
const Total = z.object({ total: z.number().nullable() });
const Pause = z.object({ paused_until: z.number() });

/**
 * `RateLimitRepository` on the application's SQLite file (#265, S32): one row per slot. `acquire`
 * forgets the key's expired slots, counts the valid ones and takes one in one `BEGIN IMMEDIATE`
 * transaction, so instances on one file never hold more than `maxSlots` together; `renew` extends
 * only a slot still valid. Times are the framework clock's milliseconds. Listed in
 * `@Application({ providers })`; needs `sqlitePath`.
 */
@Injectable({ deps: [SqliteConnection, Clock, ApplicationContext] })
export class SqliteRateLimitRepository extends RateLimitRepository {
  constructor(
    private readonly connection: SqliteConnection,
    private readonly clock: Clock,
    private readonly applicationContext: ApplicationContext,
  ) {
    super();
    connection.ensureSchema("rate_limit_slots", SCHEMA);
    connection.ensureSchema("rate_limit_windows", WINDOWS_SCHEMA);
  }

  acquire(key: string, maxSlots: number, lease: Milliseconds): Promise<RateLimitLease | undefined> {
    const now = this.clock.now().getTime();
    const { database } = this.connection;
    const slot = this.connection.transaction((): RateLimitLease | undefined => {
      database
        .prepare("DELETE FROM rate_limit_slots WHERE slot_key = ? AND expires_at <= ?")
        .run(key, now);
      const { taken } = Count.parse(
        database
          .prepare("SELECT COUNT(*) AS taken FROM rate_limit_slots WHERE slot_key = ?")
          .get(key),
      );
      if (taken >= maxSlots) return undefined;
      const next: RateLimitLease = {
        key,
        slotId: randomUUID(),
        holderInstanceId: this.applicationContext.instanceId,
        expiresAt: new Date(now + lease),
      };
      database
        .prepare("INSERT INTO rate_limit_slots VALUES (?, ?, ?, ?)")
        .run(next.slotId, key, this.applicationContext.instanceId, now + lease);
      return next;
    });
    return Promise.resolve(slot);
  }

  renew(rateLimitLease: RateLimitLease, lease: Milliseconds): Promise<boolean> {
    const now = this.clock.now().getTime();
    const { changes } = this.connection.database
      .prepare("UPDATE rate_limit_slots SET expires_at = ? WHERE slot_id = ? AND expires_at > ?")
      .run(now + lease, rateLimitLease.slotId, now);
    return Promise.resolve(Number(changes) === 1);
  }

  release(rateLimitLease: RateLimitLease): Promise<void> {
    this.connection.database
      .prepare("DELETE FROM rate_limit_slots WHERE slot_id = ?")
      .run(rateLimitLease.slotId);
    return Promise.resolve();
  }

  addToWindow(
    key: string,
    amount: number,
    window: Milliseconds,
    limit?: number,
  ): Promise<number | undefined> {
    const now = this.clock.now().getTime();
    const { database } = this.connection;
    const total = this.connection.transaction((): number | undefined => {
      database
        .prepare("DELETE FROM rate_limit_window_entries WHERE window_key = ? AND counted_at <= ?")
        .run(key, now - window);
      const counted = Total.parse(
        database
          .prepare(
            "SELECT SUM(amount) AS total FROM rate_limit_window_entries WHERE window_key = ?",
          )
          .get(key),
      );
      const next = (counted.total ?? 0) + amount;
      if (limit !== undefined && next > limit) return undefined;
      if (amount !== 0) {
        database
          .prepare("INSERT INTO rate_limit_window_entries VALUES (?, ?, ?)")
          .run(key, now, amount);
      }
      return next;
    });
    return Promise.resolve(total);
  }

  clearWindow(key: string): Promise<void> {
    this.connection.database
      .prepare("DELETE FROM rate_limit_window_entries WHERE window_key = ?")
      .run(key);
    return Promise.resolve();
  }

  pauseUntil(key: string, until: Date): Promise<void> {
    this.connection.database
      .prepare(
        `INSERT INTO rate_limit_pauses VALUES (?, ?) ON CONFLICT(pause_key)
         DO UPDATE SET paused_until = MAX(paused_until, excluded.paused_until)`,
      )
      .run(key, until.getTime());
    return Promise.resolve();
  }

  pausedUntil(key: string): Promise<Date | undefined> {
    const row = this.connection.database
      .prepare("SELECT paused_until FROM rate_limit_pauses WHERE pause_key = ?")
      .get(key);
    const until = row === undefined ? undefined : Pause.parse(row).paused_until;
    return Promise.resolve(
      until !== undefined && until > this.clock.now().getTime() ? new Date(until) : undefined,
    );
  }
}

sqliteImplementation(SqliteRateLimitRepository);
