import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Injectable } from "../../components/decorators.js";
import type { Milliseconds } from "../../units/index.js";
import { INFRASTRUCTURE_CLOCK, INSTANCE_ID } from "../clock.js";
import { RateLimitRepository, type RateLimitLease } from "../rate-limit.repository.js";
import { SqliteConnection, sqliteImplementation } from "./sqlite-connection.js";

const SCHEMA = `CREATE TABLE IF NOT EXISTS rate_limit_slots (
  slot_id TEXT PRIMARY KEY, slot_key TEXT NOT NULL, holder_instance_id TEXT NOT NULL,
  expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS rate_limit_slots_key ON rate_limit_slots(slot_key, expires_at);`;

const Count = z.object({ taken: z.number() });

/**
 * `RateLimitRepository` on the application's SQLite file (#265, S32): one row per slot. `acquire`
 * forgets the key's expired slots, counts the valid ones and takes one in one `BEGIN IMMEDIATE`
 * transaction, so instances on one file never hold more than `maxSlots` together; `renew` extends
 * only a slot still valid. Times are the framework clock's milliseconds. Listed in
 * `@Application({ providers })`; needs `sqlitePath`.
 */
@Injectable({ deps: [SqliteConnection, INFRASTRUCTURE_CLOCK, INSTANCE_ID] })
export class SqliteRateLimitRepository extends RateLimitRepository {
  constructor(
    private readonly connection: SqliteConnection,
    private readonly now: () => Date,
    private readonly instanceId: string,
  ) {
    super();
    connection.ensureSchema("rate_limit_slots", SCHEMA);
  }

  acquire(key: string, maxSlots: number, lease: Milliseconds): Promise<RateLimitLease | undefined> {
    const now = this.now().getTime();
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
        holderInstanceId: this.instanceId,
        expiresAt: new Date(now + lease),
      };
      database
        .prepare("INSERT INTO rate_limit_slots VALUES (?, ?, ?, ?)")
        .run(next.slotId, key, this.instanceId, now + lease);
      return next;
    });
    return Promise.resolve(slot);
  }

  renew(rateLimitLease: RateLimitLease, lease: Milliseconds): Promise<boolean> {
    const now = this.now().getTime();
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
}

sqliteImplementation(SqliteRateLimitRepository);
