/**
 * #1069 — the abandonment on its own: its cause until it is abandoned and after, one hand-over for
 * any number of askers, and the line a release says, with its names, or nothing where no log is.
 */
import { describe, expect, it } from "vitest";
import { Abandonment } from "../../src/app/lease-abandon.js";
import type { FrameworkLog } from "../../src/infrastructure/logger.js";
import { StoreOutcomeSource, StoreOutcomeUnknownError } from "../../src/index.js";

const cause = new StoreOutcomeUnknownError({
  store: "RateLimitRepository",
  operation: "acquire",
  source: StoreOutcomeSource.Framework,
});

describe("#1069: Abandonment", () => {
  it("has no cause until it is abandoned, then the first one", async () => {
    const abandonment = new Abandonment();
    expect(abandonment.cause).toBeUndefined();

    await abandonment.run(cause, () => Promise.resolve());
    await abandonment.run(
      new StoreOutcomeUnknownError({
        store: "Other",
        operation: "x",
        source: StoreOutcomeSource.Transport,
      }),
      () => Promise.resolve(),
    );

    expect(abandonment.cause).toBe(cause);
  });

  it("tells a release that it was abandoned, with the execution, tenant and token", async () => {
    const abandonment = new Abandonment();
    const told: { code: string; message: string; meta: unknown }[] = [];
    const log: FrameworkLog = {
      info: () => undefined,
      warn: (code, message, meta) => void told.push({ code, message, meta }),
      error: () => undefined,
    };
    const lease = { executionId: "root-9", tenantId: "acme", token: 4 };

    expect(abandonment.told(log, lease)).toBe(false);
    expect(told).toEqual([]);
    await abandonment.run(cause, () => Promise.resolve());
    expect(abandonment.told(log, lease)).toBe(true);

    expect(told).toEqual([
      {
        code: "execution.lease-abandoned",
        message:
          "the lease of execution root-9 (token 4) was abandoned: RateLimitRepository.acquire ended with its outcome unknown (framework) — nothing is released, the lease expires in its store and the next take of it reconciles",
        meta: { executionId: "root-9", tenantId: "acme" },
      },
    ]);
  });

  it("is told with no log where none is kept", async () => {
    const abandonment = new Abandonment();
    await abandonment.run(cause, () => Promise.resolve());

    expect(abandonment.told(undefined, { executionId: "root-9", tenantId: "acme" })).toBe(true);
  });
});
