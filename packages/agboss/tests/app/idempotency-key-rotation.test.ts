/**
 * #825 AC7 — the idempotency key rotated under live business keys, on one SQLite file: an intent
 * recorded before the rotation and retried during it (the previous key named) is recognised — a
 * completed one replays, a pending one is reconciled, a fenced effect replays: no
 * `IdempotencyError.KeyConflict`, nothing sent or booked twice. Once the previous key is removed,
 * what was stored under it fails closed: a conflict, nothing sent, nothing run. New rows are stored
 * under the current key only, so they replay after the previous one is gone.
 */
import { IdempotencyError } from "../../src/core/error-families/effect-errors.js";
import { createTestAppWith } from "../../src/testing/create-app-with.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { IdempotencyRunStatus, OutboundCallSendStatus, type App } from "../../src/index.js";
import { execute } from "./../helpers/flow.js";
import { gateway, resetGateway } from "./fixtures/payment-gateway.js";
import {
  BookOrderStart,
  ChargeOrderStart,
  resetRotation,
  rotation,
  RotationAfterApplication,
  RotationBeforeApplication,
  RotationDuringApplication,
} from "./fixtures/rotation/rotation.application.js";
import type { Class } from "../../src/components/injection.js";

const folder = mkdtempSync(join(tmpdir(), "agboss-rotation-"));
let file = "";
let opened: App[] = [];

/** One instance of `application` on the test's file, the two keys in its process. */
async function instanceOf(application: Class): Promise<App> {
  const processEnv = {
    ROTATION_SQLITE_PATH: file,
    ROTATION_IDEMPOTENCY_KEY_V1: "key-before-the-rotation",
    ROTATION_IDEMPOTENCY_KEY_V2: "key-after-the-rotation",
    ROTATION_OPENROUTER_API_KEY: "sk-unused",
  };
  const app = await createTestAppWith(application, { processEnv });
  opened.push(app);
  return app;
}

/** Closes an instance (its connection too) before the next one opens the file. */
async function closed(app: App): Promise<void> {
  await app.close();
  opened = opened.filter((open) => open !== app);
}

const ORDER = { orderId: "42", amountUsd: 10 };

beforeEach(() => {
  file = join(folder, `rotation-${String(Date.now())}-${String(Math.random()).slice(2)}.sqlite`);
  resetGateway();
  resetRotation();
});

afterEach(async () => {
  for (const app of opened) await app.close();
  opened = [];
});

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

/** The bookings committed on the file. */
const bookingsOn = (path: string): number => {
  const database = new DatabaseSync(path);
  try {
    const row = database.prepare("SELECT count(*) AS n FROM rotation_bookings").get() as {
      readonly n: number;
    };
    return row.n;
  } finally {
    database.close();
  }
};

// under a loaded gate (3 workers beside other gates) a case here ran 5.7-11 s against vitest's 5 s default, and 0.6-3 s alone (#1225, as #1160): the bound says "not hung"
describe("#825 AC7: an outbound call recorded before the rotation", { timeout: 60_000 }, () => {
  it("completed before, retried during it: replayed — no conflict, sent once", async () => {
    const first = await instanceOf(RotationBeforeApplication);
    await execute(first, ChargeOrderStart, ORDER);
    await closed(first);

    const during = await execute(
      await instanceOf(RotationDuringApplication),
      ChargeOrderStart,
      ORDER,
    );

    expect(during.finish).toBeDefined();
    expect(rotation.calls).toEqual([OutboundCallSendStatus.Sent, OutboundCallSendStatus.Replayed]);
    expect(gateway.calls).toHaveLength(1);
  });

  it("left pending before (its answer lost), retried during it: reconciled, never resent", async () => {
    gateway.failNext = 1; // an error of unknown outcome: the intent stays pending
    const before = await instanceOf(RotationBeforeApplication);
    await expect(execute(before, ChargeOrderStart, ORDER)).rejects.toThrow();
    await closed(before);
    const wireKey = gateway.calls[0]?.idempotencyKey ?? "";
    gateway.charges.set(wireKey, { chargeId: "ch-42-lost" });

    await execute(await instanceOf(RotationDuringApplication), ChargeOrderStart, ORDER);

    expect(rotation.calls).toEqual([OutboundCallSendStatus.Reconciled]);
    expect(gateway.calls).toHaveLength(1);
    // the intent kept its wire key: the lookup asks for the one the first send used, whatever the secret is now
    expect(gateway.lookups).toEqual([{ idempotencyKey: wireKey, attempt: 1 }]);
  });

  it("after the previous secret is removed: the row written under it is no longer found — the call is made again, under a key of the new secret (keep the previous secret for the longest ttl)", async () => {
    const first = await instanceOf(RotationBeforeApplication);
    await execute(first, ChargeOrderStart, ORDER);
    await closed(first);

    await execute(await instanceOf(RotationAfterApplication), ChargeOrderStart, ORDER);

    expect(gateway.calls).toHaveLength(2);
    expect(gateway.calls[1]?.idempotencyKey).not.toBe(gateway.calls[0]?.idempotencyKey);
  });

  it("another request during the rotation is still a conflict under either key", async () => {
    const first = await instanceOf(RotationBeforeApplication);
    await execute(first, ChargeOrderStart, ORDER);
    await closed(first);

    await expect(
      execute(await instanceOf(RotationDuringApplication), ChargeOrderStart, {
        ...ORDER,
        amountUsd: 12,
      }),
    ).rejects.toFailWith(IdempotencyError.KeyConflict, { effect: "charge" });
    expect(gateway.calls).toHaveLength(1);
  });

  it("recorded during the rotation: stored under the current key — replayed once the previous one is gone", async () => {
    const first = await instanceOf(RotationDuringApplication);
    await execute(first, ChargeOrderStart, ORDER);
    await closed(first);

    await execute(await instanceOf(RotationAfterApplication), ChargeOrderStart, ORDER);

    expect(rotation.calls).toEqual([OutboundCallSendStatus.Sent, OutboundCallSendStatus.Replayed]);
    expect(gateway.calls).toHaveLength(1);
  });
});

// under a loaded gate (3 workers beside other gates) a case here ran 5.7-11 s against vitest's 5 s default, and 0.6-3 s alone (#1225, as #1160): the bound says "not hung"
describe("#825 AC7: a fenced effect stored before the rotation", { timeout: 60_000 }, () => {
  it("retried during it: replayed, booked once; after the previous secret is removed: the row is not found, the write runs again", async () => {
    const first = await instanceOf(RotationBeforeApplication);
    await execute(first, BookOrderStart, ORDER);
    await closed(first);
    const during = await instanceOf(RotationDuringApplication);
    await execute(during, BookOrderStart, ORDER);
    await closed(during);

    await execute(await instanceOf(RotationAfterApplication), BookOrderStart, ORDER);

    // the row written under the removed previous secret is not found: the write runs again
    expect(rotation.effects).toEqual([
      IdempotencyRunStatus.Ran,
      IdempotencyRunStatus.Replayed,
      IdempotencyRunStatus.Ran,
    ]);
    expect(bookingsOn(file)).toBe(2);
  });
});
