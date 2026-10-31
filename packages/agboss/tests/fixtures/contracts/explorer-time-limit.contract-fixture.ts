// #590: the explorer on a sound store with a time limit no search fits in — its cases must fail
// with what they explored, never pass on a partial search.
import { registerInterleavings } from "../../../src/testing/contracts/explorer/register.js";
import { inMemoryOutboundCalls } from "../../infrastructure/contracts/outbound-call-stores.js";
import { inMemoryTarget } from "../../infrastructure/contracts/store-kinds.js";

registerInterleavings(
  "a search past its time limit",
  { outboundCall: inMemoryTarget(inMemoryOutboundCalls) },
  { depth: 12, walks: 100_000, timeLimit: 1 },
);
