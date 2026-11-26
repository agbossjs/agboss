/**
 * #1324b (the environment flip): the keys that make a payment's fingerprint and a PII token must not
 * change with the way they are resolved. The expected values below were captured on main BEFORE the
 * flip, from fixed key texts; they are literals, never recomputed — a different value is a different
 * fingerprint (a repeated charge, or a false refusal) or a different token (a masked value that no
 * longer matches what was stored).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { Application } from "../../src/application/application.js";
import { fingerprintsUnder } from "../../src/infrastructure/fenced-effect-fingerprint.js";
import { tokenOf } from "../../src/pii/tokens.js";
import { createAppWith } from "../../src/application/create-app.js";
import { createTestAppWith } from "../../src/testing/create-app-with.js";
import { DatabaseStorage, SqliteDriver, env, secret } from "../../src/index.js";
import { hours } from "../../src/units/index.js";
import { TEST_BUDGETS } from "../flow/fixtures/budgets.js";
import { execute } from "../helpers/flow.js";
import {
  BookOrderStart,
  BookOrderWorkflow,
} from "../app/fixtures/rotation/rotation.application.js";

const CURRENT = "golden-idempotency-secret";
const PREVIOUS = "golden-previous-secret";

/** Fingerprints captured on main for `{ amountUsd: 10 }` under the two keys above. */
const GOLDEN_FINGERPRINT = "db71727be8a20191b5ad88a9cc824a9f6905f6a1a30e6d947f807ce3606da89d";
const GOLDEN_PREVIOUS_FINGERPRINT =
  "b9f59f38f009e8ef003a8c5b3499222191a35e0fb6cd665cdc69394ae8de836f";
/** The business key `order:42` as the store keeps it: its digest under the current key. */
const GOLDEN_BUSINESS_KEY = "IrCBn1ps82vKW3Y4ps4UZ-ryGcmZ3wBB4ctn1tmhYu4";

describe("#1324b golden: business-key fingerprints", () => {
  it("fingerprintsUnder: the same digests as before the flip", () => {
    expect(fingerprintsUnder({ current: CURRENT, previous: PREVIOUS }, { amountUsd: 10 })).toEqual({
      fingerprint: GOLDEN_FINGERPRINT,
      previousFingerprint: GOLDEN_PREVIOUS_FINGERPRINT,
    });
  });
});

describe("#1324b golden: the stored fingerprint of a real application", () => {
  const folder = mkdtempSync(join(tmpdir(), "agboss-golden-"));
  afterAll(() => {
    rmSync(folder, { recursive: true, force: true });
  });

  @DatabaseStorage({
    name: "golden-storage",
    driver: SqliteDriver({ path: env("GOLDEN_SQLITE_PATH") }),
    auditLogTtl: hours(24),
    ledgerEntriesTtl: hours(24),
    idempotencySecret: secret("GOLDEN_IDEMPOTENCY"),
    previousIdempotencySecret: secret("GOLDEN_PREVIOUS_IDEMPOTENCY"),
  })
  class GoldenStorage {}

  @Application({
    name: "golden-application",
    version: "1.0.0",
    workflows: [BookOrderWorkflow],
    storage: GoldenStorage,
    budgets: TEST_BUDGETS,
  })
  class GoldenApplication {}

  it("a missing secret fails the start closed, naming the variable and never a value", async () => {
    const processEnv = {
      GOLDEN_SQLITE_PATH: join(folder, "closed.sqlite"),
      GOLDEN_PREVIOUS_IDEMPOTENCY: PREVIOUS,
    };

    const failure = await createAppWith(GoldenApplication, { processEnv }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(Error);
    const text = String((failure as Error).message);
    expect(text).toContain("GOLDEN_IDEMPOTENCY is not set");
    expect(text).not.toContain(PREVIOUS);
  });

  it("an order booked under `order:42` is stored under the golden fingerprint, never under a key's text", async () => {
    const file = join(folder, "golden.sqlite");
    const processEnv = {
      GOLDEN_SQLITE_PATH: file,
      GOLDEN_IDEMPOTENCY: CURRENT,
      GOLDEN_PREVIOUS_IDEMPOTENCY: PREVIOUS,
    };
    const app = await createTestAppWith(GoldenApplication, { processEnv });
    try {
      await execute(app, BookOrderStart, { orderId: "42", amountUsd: 10 });
    } finally {
      await app.close();
    }

    const database = new DatabaseSync(file);
    try {
      const rows = database
        .prepare("SELECT business_key, facts FROM fenced_effect_business_results")
        .all() as readonly { readonly business_key: string; readonly facts: string }[];
      expect(rows).toHaveLength(1);
      const serialised = JSON.stringify(rows);
      expect(serialised).toContain(GOLDEN_FINGERPRINT);
      expect(serialised).not.toContain(GOLDEN_PREVIOUS_FINGERPRINT);
      expect(serialised).not.toContain(CURRENT);
      expect(serialised).not.toContain(PREVIOUS);
      expect(rows[0]?.business_key).toBe(GOLDEN_BUSINESS_KEY);
    } finally {
      database.close();
    }
  });
});

describe("#1324b golden: PII tokens", () => {
  const key = "shared-app-key";

  it("tokenOf: the same tokens as before the flip", () => {
    expect(tokenOf("employee-token", "EMP-0042", key, {})).toBe("<employee-token:076cf8>");
    expect(tokenOf("user-id", "zoe-7", key, {})).toBe("<user-id:102389>");
    expect(tokenOf("phone", "+1 555 123 4567", key, {})).toBe("<phone:fad6cc>");
    expect(tokenOf("email", "alice@example.com", "golden-pii-secret", {})).toBe("<email:95b0ec>");
  });
});
