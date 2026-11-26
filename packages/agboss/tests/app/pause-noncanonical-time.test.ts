/**
 * #1307 review M1/M2: the core reads a record's time only in its canonical `toISOString()` spelling, the
 * one the store's own compare-and-set agrees with by text. Any other spelling is a loud
 * `StoreError.UnreadableRecord`, never a deadline read in the process's zone, never an Invalid Date,
 * never a caller told "retry is safe" over a record the store keeps refusing.
 */
import { beforeEach, describe, expect, vi } from "vitest";
import { refusedOnExpiry } from "../../src/app/pause-expiry-reassign.js";
import type { PauseRecord } from "../../src/infrastructure/pause-record.js";
import { StoreError } from "../../src/core/error-families/store-errors.js";
import { testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  ExpiryApplication,
  ExpiryWorkflowStart,
  expiryStore,
  resetExpiry,
} from "../flow/fixtures/expiry.fixture.js";

const test = testWith(ExpiryApplication);
const BAD = "2026-01-06T11:00:00+02:00";

beforeEach(resetExpiry);

describe("M1: a record's time in another spelling is refused loudly", () => {
  test("an answer to a pause whose deadline is spelled with an offset: StoreError.UnreadableRecord, not UpdateContended", async ({
    app,
  }) => {
    const paused = await execute(
      app,
      ExpiryWorkflowStart,
      { orderId: "o-1" },
      { threadId: "nc-1" },
    );
    const store = expiryStore();
    const [pause] = await store.findAllByTenantIdAndRootExecutionId("default", paused.executionId);
    if (pause === undefined) throw new Error("no pause was opened");
    vi.spyOn(store, "findByTenantIdAndPauseId").mockResolvedValue({ ...pause, expiresAt: BAD });

    const refused: unknown = await app
      .resume({ pauseId: pause.pauseId, decision: { approved: true } }, { actor: { id: "m-1" } })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(refused).toBeInstanceOf(StoreError.UnreadableRecord);
    expect(JSON.stringify(refused)).not.toContain(BAD);
  });

  test("the store refused an expiry's move and the record it re-reads has a time in another spelling: loud, not `failed` or `lost` by a guess", async ({
    app,
  }) => {
    const paused = await execute(
      app,
      ExpiryWorkflowStart,
      { orderId: "o-2" },
      { threadId: "nc-2" },
    );
    const store = expiryStore();
    const [pause] = await store.findAllByTenantIdAndRootExecutionId("default", paused.executionId);
    if (pause === undefined) throw new Error("no pause was opened");
    const stores = {
      pauses: {
        findByTenantIdAndPauseId: (): Promise<PauseRecord> =>
          Promise.resolve({ ...pause, expiresAt: BAD }),
      },
    };

    await expect(refusedOnExpiry(stores as never, pause)).rejects.toBeInstanceOf(
      StoreError.UnreadableRecord,
    );
    // the same record in the one spelling is `failed`: the pause is as it was planned for
    stores.pauses.findByTenantIdAndPauseId = () => Promise.resolve(pause);
    await expect(refusedOnExpiry(stores as never, pause)).resolves.toBe("failed");
  });
});
