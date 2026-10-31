// #508, #505, #483 acceptance: the guarantee contracts against naive stores (naive-guarantees.ts).
import {
  costLedgerContract,
  fencedEffectContract,
  meshRequestContract,
  outboundCallContract,
  rateLimitContract,
} from "../../../src/testing/contracts/index.js";
import { inMemoryFencedEffects } from "../../infrastructure/contracts/fenced-effect-stores.js";
import { inMemoryOutboundCalls } from "../../infrastructure/contracts/outbound-call-stores.js";
import { inMemoryTarget, sharedInMemory } from "../../infrastructure/contracts/store-kinds.js";
import {
  currentToken,
  LookThenWriteMeshRequestRepository,
  ReadThenWriteCostLedgerRepository,
  rewritingKeys,
  stepOnly,
  UncountedRateLimitRepository,
  type KeyRewrite,
} from "./naive-guarantees.js";

const effectsWith = (rewrite: KeyRewrite) =>
  inMemoryTarget((seam) => {
    const stores = inMemoryFencedEffects(false)(seam);
    return { ...stores, effects: rewritingKeys(stores.effects, seam.database, rewrite) };
  });

const callsWith = (rewrite: KeyRewrite) =>
  inMemoryTarget((seam) => {
    const stores = inMemoryOutboundCalls(seam);
    return { ...stores, calls: rewritingKeys(stores.calls, seam.database, rewrite) };
  });

fencedEffectContract({ ...effectsWith(stepOnly), name: "effects keyed by the step only" });
fencedEffectContract({ ...effectsWith(currentToken), name: "effects trusting the current lease" });
outboundCallContract({ ...callsWith(stepOnly), name: "calls keyed by the step only" });
outboundCallContract({ ...callsWith(currentToken), name: "calls trusting the current lease" });
rateLimitContract({
  ...inMemoryTarget(
    ({ clock, application, database }) =>
      new UncountedRateLimitRepository(clock, application, database),
  ),
  name: "a rate limit that never counts",
});
meshRequestContract({
  ...inMemoryTarget(({ database }) => new LookThenWriteMeshRequestRepository(database)),
  name: "mesh requests looked up, then written",
});
costLedgerContract({
  ...inMemoryTarget((seam) =>
    sharedInMemory(seam, "naive-ledger", () => new ReadThenWriteCostLedgerRepository()),
  ),
  name: "a ledger that reads, then writes",
});
