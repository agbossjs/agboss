/**
 * #818 — `OncePerTenant`, the knowledge base's first look at a tenant: run by the first caller,
 * joined by the rest, each waiting under its own signal; a failed run is no run.
 */
import { describe, expect, it } from "vitest";
import { OncePerTenant } from "../../src/rag/once-per-tenant.js";

/** Work the test ends by hand, counting its runs. */
function controlled() {
  const runs: { readonly tenantId: string; end: () => void; fail: (error: Error) => void }[] = [];
  const once = new OncePerTenant(
    (tenantId, signal) =>
      new Promise<void>((resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(signal.reason as Error);
        });
        runs.push({ tenantId, end: resolve, fail: reject });
      }),
  );
  return { once, runs };
}

const live = (): AbortSignal => new AbortController().signal;
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("#818: OncePerTenant", () => {
  it("one run per tenant, however many callers come while it runs; another tenant runs its own", async () => {
    const { once, runs } = controlled();

    const calls = [once.run("acme", live()), once.run("acme", live()), once.run("globex", live())];
    for (const run of runs) run.end();
    await Promise.all(calls);
    await once.run("acme", live());

    expect(runs.map((run) => run.tenantId)).toEqual(["acme", "globex"]);
  });

  it("a waiter's own abort ends its wait at once, with its reason; the run goes on for the others", async () => {
    const { once, runs } = controlled();
    const waiter = new AbortController();
    const settled: string[] = [];

    const first = once.run("acme", live()).then(() => settled.push("first"));
    const waiting = once.run("acme", waiter.signal).catch((error: unknown) => {
      settled.push(`waiter: ${(error as Error).message}`);
    });
    waiter.abort(new Error("waiter gone"));
    await waiting;
    expect(settled).toEqual(["waiter: waiter gone"]);
    runs[0]?.end();
    await first;

    expect(settled).toEqual(["waiter: waiter gone", "first"]);
    expect(runs).toHaveLength(1);
  });

  it("the first caller's abort: a waiter with a live signal runs it itself", async () => {
    const { once, runs } = controlled();
    const caller = new AbortController();

    const first = once.run("acme", caller.signal);
    const waiting = once.run("acme", live());
    caller.abort(new Error("caller gone"));
    await expect(first).rejects.toThrow("caller gone");
    await settle();
    runs[1]?.end();
    await waiting;

    expect(runs).toHaveLength(2);
  });

  it("a run that failed of itself fails its waiters with that failure, and the next caller runs it again", async () => {
    const { once, runs } = controlled();

    const calls = Promise.allSettled([once.run("acme", live()), once.run("acme", live())]);
    runs[0]?.fail(new Error("folder unreadable"));
    const outcomes = await calls;
    const again = once.run("acme", live());
    runs[1]?.end();
    await again;

    expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
    expect(runs).toHaveLength(2);
  });

  it("an aborted signal is refused before anything runs", async () => {
    const { once, runs } = controlled();
    const aborted = new AbortController();
    aborted.abort(new Error("already gone"));

    await expect(once.run("acme", aborted.signal)).rejects.toThrow("already gone");
    expect(runs).toEqual([]);
  });
});
