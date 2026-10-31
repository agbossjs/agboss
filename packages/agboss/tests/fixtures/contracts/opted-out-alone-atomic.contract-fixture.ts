// #543 acceptance: the outbound-call contract run alone on the core's atomic store, the flag set anyway.
import { outboundCallContract } from "../../../src/testing/contracts/index.js";
import { inMemoryOutboundCalls } from "../../infrastructure/contracts/outbound-call-stores.js";
import { inMemoryTarget } from "../../infrastructure/contracts/store-kinds.js";

outboundCallContract(
  { ...inMemoryTarget(inMemoryOutboundCalls), name: "an atomic store run alone, the flag set" },
  { acceptWithoutDoubleChargeProtection: true },
);
