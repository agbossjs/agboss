/**
 * #266 S34, S58, S60: a provider's waiting calls, grouped by tenant — round-robin by default, the
 * least busy tenant, weights per round, or one FIFO queue; a waiter that leaves its bucket.
 */
import { describe, expect, it } from "vitest";
import {
  TenantFairQueue,
  type InFlightOf,
  type QueueTicket,
} from "../../src/models/calls/tenant-fair-queue.js";
import { QueueBalancingStrategy } from "../../src/models/index.js";

interface Call extends QueueTicket {
  readonly label: string;
}

const call = (tenantId: string, label: string, weight = 1): Call => ({ tenantId, weight, label });
const idle: InFlightOf = () => 0;

/** The order the queue gives its waiters out, one slot at a time. */
function served(queue: TenantFairQueue<Call>, inFlight: InFlightOf = idle): string[] {
  const order: string[] = [];
  for (let next = queue.peek(inFlight); next !== undefined; next = queue.peek(inFlight)) {
    queue.take(next);
    order.push(next.label);
  }
  return order;
}

describe("#266 S34: the tenant-fair queue", () => {
  it("a 50-item launch of one tenant and a single call of another: the second tenant gets the next free slot", () => {
    const queue = new TenantFairQueue<Call>(QueueBalancingStrategy.TenantRoundRobin);
    for (let item = 0; item < 50; item++) queue.add(call("batch-tenant", `batch-${String(item)}`));
    const first = queue.peek(idle);
    if (first !== undefined) queue.take(first);

    queue.add(call("chat-tenant", "chat"));

    expect(served(queue).slice(0, 2)).toEqual(["chat", "batch-1"]);
  });

  it("one tenant is plain FIFO; tenants alternate round-robin", () => {
    const queue = new TenantFairQueue<Call>(QueueBalancingStrategy.TenantRoundRobin);
    for (const label of ["a1", "a2", "a3"]) queue.add(call("a", label));
    for (const label of ["b1", "b2"]) queue.add(call("b", label));

    expect(served(queue)).toEqual(["a1", "b1", "a2", "b2", "a3"]);
    expect(queue.size).toBe(0);
  });

  it("a cancelled waiter at the head of a bucket leaves it at once; an empty bucket leaves the ring", () => {
    const queue = new TenantFairQueue<Call>(QueueBalancingStrategy.TenantRoundRobin);
    const cancelled = call("a", "a1");
    queue.add(cancelled);
    queue.add(call("a", "a2"));
    const alone = call("b", "b1");
    queue.add(alone);

    queue.remove(cancelled);
    queue.remove(alone);

    expect(queue.size).toBe(1);
    expect(served(queue)).toEqual(["a2"]);
  });

  it("S58 TenantLeastInFlight: a free slot goes to the waiting tenant with the fewest calls in flight", () => {
    const queue = new TenantFairQueue<Call>(QueueBalancingStrategy.TenantLeastInFlight);
    queue.add(call("busy", "busy-1"));
    queue.add(call("quiet", "quiet-1"));
    const inFlight = (tenantId: string): number => (tenantId === "busy" ? 5 : 0);

    expect(queue.peek(inFlight)?.label).toBe("quiet-1");
    expect(served(queue, inFlight)).toEqual(["quiet-1", "busy-1"]);
  });

  it("S60 TenantWeighted: a tenant of weight 3 gets up to 3 slots per round against 1", () => {
    const queue = new TenantFairQueue<Call>(QueueBalancingStrategy.TenantWeighted);
    for (let item = 1; item <= 5; item++) queue.add(call("enterprise", `e${String(item)}`, 3));
    for (let item = 1; item <= 3; item++) queue.add(call("free", `f${String(item)}`));

    expect(served(queue)).toEqual(["e1", "e2", "e3", "f1", "e4", "e5", "f2", "f3"]);
  });

  it("S58 Fifo: one queue in arrival order, no split by tenant", () => {
    const queue = new TenantFairQueue<Call>(QueueBalancingStrategy.Fifo);
    for (const [tenant, label] of [
      ["a", "a1"],
      ["a", "a2"],
      ["b", "b1"],
    ] as const) {
      queue.add(call(tenant, label));
    }

    expect(served(queue)).toEqual(["a1", "a2", "b1"]);
  });

  it("weights are ignored by the other strategies; takeAll empties the queue", () => {
    const queue = new TenantFairQueue<Call>(QueueBalancingStrategy.TenantRoundRobin);
    queue.add(call("a", "a1", 3));
    queue.add(call("a", "a2", 3));
    queue.add(call("b", "b1"));
    const first = queue.peek(idle);
    if (first !== undefined) queue.take(first);

    expect(queue.peek(idle)?.label).toBe("b1");
    expect(queue.takeAll().map((each) => each.label)).toEqual(["a2", "b1"]);
    expect(queue.peek(idle)).toBeUndefined();
  });
});
