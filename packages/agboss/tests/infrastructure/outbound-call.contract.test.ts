/**
 * #505 AC4, AC5: the calls that leave the system — the published outbound-call contract
 * (`outboundCallContract`), run against the built-in in-memory store (two instances over one
 * database) and against `SqliteOutboundCallRepository` (two connections to one file).
 */
import { describe } from "vitest";
import { outboundCallContract } from "../../src/testing/contracts/index.js";
import { inMemoryOutboundCalls, sqliteOutboundCalls } from "./contracts/outbound-call-stores.js";
import { inMemoryTarget, sqliteTarget } from "./contracts/store-kinds.js";

describe("#505 AC5: the in-memory and SQLite outbound-call stores pass the published outbound-call contract", () => {
  outboundCallContract(inMemoryTarget(inMemoryOutboundCalls));
  outboundCallContract(sqliteTarget(sqliteOutboundCalls));
});
