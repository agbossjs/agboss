// #533 item 1, AC1: the interleaving explorer on each naive fencing store (explorer-broken-stores.ts).
import { registerInterleavings } from "../../../src/testing/contracts/explorer/register.js";
import { BROKEN_CALL_TARGETS, BROKEN_EFFECT_TARGETS } from "./explorer-broken-stores.js";

const BUDGET = { depth: 8, walks: 40, walkDepth: 24 };

for (const [name, outboundCall] of Object.entries(BROKEN_CALL_TARGETS))
  registerInterleavings(name, { outboundCall }, BUDGET);
for (const [name, fencedEffect] of Object.entries(BROKEN_EFFECT_TARGETS))
  registerInterleavings(name, { fencedEffect }, BUDGET);
