/**
 * #1366 (cancel-stores shard) — what the in-memory stores share: a thread's key in their maps names the tenant and the
 * thread and can never be confused with another pair's, the rows the memory starts with (none: the audit log empty, the
 * outbound calls' record order counted from 0), and the tokens every container of an application has.
 */
import { describe, expect, it } from "vitest";
import { OutboundMasking } from "../../src/app/outbound-masking.js";
import {
  INFRASTRUCTURE_TOKENS,
  IN_MEMORY_DATABASE,
  InMemoryDatabase,
  threadMapKeyOf,
} from "../../src/infrastructure/in-memory-database.js";

describe("#1366: a thread's key in the in-memory stores' maps", () => {
  it("names the tenant and the thread, in that order", () => {
    expect(threadMapKeyOf({ tenantId: "t1", threadId: "th1" })).toBe('["t1","th1"]');
  });

  it("is never the key of another pair, whatever separators the ids hold", () => {
    const keys = [
      threadMapKeyOf({ tenantId: "a,b", threadId: "c" }),
      threadMapKeyOf({ tenantId: "a", threadId: "b,c" }),
      threadMapKeyOf({ tenantId: 'a","b', threadId: "c" }),
      threadMapKeyOf({ tenantId: "c", threadId: "a,b" }),
    ];

    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("#1366: the memory the in-memory stores keep their rows in", () => {
  it("starts with none: no audit event, and the outbound calls' places counted from nothing", () => {
    const database = new InMemoryDatabase();

    expect(database.executionAuditLog).toEqual([]);
    expect(database.outboundCallPlaces).toEqual({ highest: 0 });
    expect(database.outboundCalls.size).toBe(0);
    expect(database.outboundCallOrder.size).toBe(0);
  });

  it("is made afresh for each database: the places of one are not another's", () => {
    const first = new InMemoryDatabase();
    const second = new InMemoryDatabase();
    first.outboundCallPlaces.highest = 7;
    first.executionAuditLog.push({} as never);

    expect(second.outboundCallPlaces.highest).toBe(0);
    expect(second.executionAuditLog).toEqual([]);
  });

  it("is given by its token, the first of the core values every container has", () => {
    expect(IN_MEMORY_DATABASE.description).toBe("IN_MEMORY_DATABASE");
    expect(INFRASTRUCTURE_TOKENS).toEqual([IN_MEMORY_DATABASE, OutboundMasking]);
  });
});
