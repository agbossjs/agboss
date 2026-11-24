import { describe, expect, it } from "vitest";
import { ticketOf } from "../../src/models/calls/model-call.js";
import { runInFrame, type FrameSpec } from "../../src/flow/context/frame.js";
import {
  QueueBalancingStrategy,
  RateLimitPolicy,
  RateLimitPolicyError,
} from "../../src/models/policies/rate-limit-policy.js";

/** #1313h: a tenant's queue weight is the provider's `tenantWeight`, not a field of the tenant. */

describe("#1313h: tenantWeight on RateLimitPolicy", () => {
  it("TenantWeighted needs a tenantWeight, and a tenantWeight needs TenantWeighted", () => {
    expect(() =>
      RateLimitPolicy.of({
        maxConcurrentCalls: 2,
        balancing: QueueBalancingStrategy.TenantWeighted,
      }),
    ).toThrow(RateLimitPolicyError);
    expect(() => RateLimitPolicy.of({ maxConcurrentCalls: 2, tenantWeight: () => 2 })).toThrow(
      RateLimitPolicyError,
    );
  });

  it("the ticket of a call carries the weight the policy gives the tenant", async () => {
    const policy = RateLimitPolicy.of({
      maxConcurrentCalls: 2,
      balancing: QueueBalancingStrategy.TenantWeighted,
      tenantWeight: (tenant) => (tenant.tenantId === "big" ? 3 : 1),
    });
    const inTenant = (tenantId: string) =>
      runInFrame({ execution: { tenant: { tenantId } } } as never, () =>
        ticketOf(undefined, policy.tenantWeight),
      );

    expect((await inTenant("big")).weight).toBe(3);
    expect((await inTenant("small")).weight).toBe(1);
    expect(ticketOf(undefined, policy.tenantWeight).weight).toBe(1);
  });

  it("a weight that is no integer from 1 is a failure, not a silent 1", async () => {
    for (const weight of [0, 1.5, Number.NaN]) {
      const policy = RateLimitPolicy.of({
        maxConcurrentCalls: 2,
        balancing: QueueBalancingStrategy.TenantWeighted,
        tenantWeight: () => weight,
      });
      await expect(
        runInFrame({ execution: { tenant: { tenantId: "t" } } } as never, () =>
          ticketOf(undefined, policy.tenantWeight),
        ),
      ).rejects.toThrow(RateLimitPolicyError);
    }
  });
});
