// #534 acceptance: the lease's boundary cases against naive stores (naive-expiry.ts).
import { InMemoryExecutionLeaseRepository } from "../../../src/infrastructure/execution-lease.repository.js";
import { FencedEffectSettings } from "../../../src/infrastructure/fenced-effect-settings.js";
import { InMemoryFencedEffectRepository } from "../../../src/infrastructure/in-memory-fenced-effect.repository.js";
import { InMemoryOutboundCallRepository } from "../../../src/infrastructure/outbound-call.repository.js";
import {
  executionLeaseContract,
  fencedEffectContract,
  outboundCallContract,
} from "../../../src/testing/contracts/index.js";
import { hours, seconds, type Milliseconds } from "../../../src/units/index.js";
import { inMemoryFencedEffects } from "../../infrastructure/contracts/fenced-effect-stores.js";
import { inMemoryTarget } from "../../infrastructure/contracts/store-kinds.js";
import {
  holderAndEpochOnly,
  LaggingClock,
  NaiveExpiryLeaseRepository,
  throughExpiry,
  type HolderLiveness,
} from "./naive-expiry.js";

const leasesWith = (liveness: HolderLiveness) =>
  inMemoryTarget(
    ({ clock, application, database }) =>
      new NaiveExpiryLeaseRepository(clock, application, database, liveness),
  );

executionLeaseContract({
  ...leasesWith(holderAndEpochOnly),
  name: "leases by holder and epoch only",
});
executionLeaseContract({ ...leasesWith(throughExpiry), name: "leases live through expiresAt" });

/** The fencing stores of a test on a clock `lag` behind their lease store's. */
const effectsLagging = (lag: Milliseconds) =>
  inMemoryTarget((seam) => {
    const honest = inMemoryFencedEffects(false)(seam);
    const late = new LaggingClock(seam.clock, lag);
    const effects = new InMemoryFencedEffectRepository(
      late,
      seam.database,
      new FencedEffectSettings(),
      honest.leases,
    );
    return { ...honest, effects };
  });

const callsLagging = (lag: Milliseconds) =>
  inMemoryTarget((seam) => {
    const leases = new InMemoryExecutionLeaseRepository(
      seam.clock,
      seam.application,
      seam.database,
    );
    const late = new LaggingClock(seam.clock, lag);
    return { calls: new InMemoryOutboundCallRepository(late, seam.database, leases), leases };
  });

const ONE_MILLISECOND = seconds(0.001);

fencedEffectContract({
  ...effectsLagging(ONE_MILLISECOND),
  name: "effects fenced through expiresAt",
});
fencedEffectContract({
  ...effectsLagging(hours(1)),
  name: "effects fenced by holder and epoch only",
});
outboundCallContract({ ...callsLagging(ONE_MILLISECOND), name: "calls fenced through expiresAt" });
outboundCallContract({ ...callsLagging(hours(1)), name: "calls fenced by holder and epoch only" });
