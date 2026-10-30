/**
 * #505 AC4, AC5: the calls that leave the system — the published outbound-call contract
 * (`outboundCallContract`), run against the built-in in-memory store (two instances over one
 * database).
 */
import { describe } from "vitest";
import { outboundCallContract } from "../../src/testing/contracts/index.js";
import { inMemoryOutboundCalls } from "./contracts/outbound-call-stores.js";
import { inMemoryTarget } from "./contracts/store-kinds.js";

describe("#505 AC5: the in-memory outbound-call store passes the published outbound-call contract", () => {
  outboundCallContract(inMemoryTarget(inMemoryOutboundCalls));
});
