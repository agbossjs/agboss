/**
 * #1317d — the key a call goes out with: a 43-character base64url HMAC of its key, never the
 * business key; minted when the intent is recorded and kept (every attempt, the lookup and a replay
 * see the same one); `shortKey(length)` is its prefix, 16 to 43 characters.
 */
import { describe, expect, it } from "vitest";
import { IdempotencyError } from "../../src/core/error-families/effect-errors.js";
import {
  businessKeyDigestsUnder,
  callKeyDigestUnder,
  shortKeyOf,
} from "../../src/infrastructure/business-key-digest.js";
import { OutboundRecovery, Reconciliation } from "../../src/index.js";
import { seconds } from "../../src/units/index.js";
import { lookupKeyOf, outboundFrame, rejectionOf } from "../helpers/outbound-frame.js";

const BASE64URL_43 = /^[A-Za-z0-9_-]{43}$/u;

describe("#1317d: the digests", () => {
  it("a business key's digest is 43 base64url characters of its text under the secret, another under another secret", () => {
    const one = businessKeyDigestsUnder({ current: "secret-a" }, "order:42");

    expect(one.businessKey).toMatch(BASE64URL_43);
    expect(one.businessKey).not.toContain("order");
    expect(businessKeyDigestsUnder({ current: "secret-a" }, "order:42")).toEqual(one);
    expect(businessKeyDigestsUnder({ current: "secret-b" }, "order:42").businessKey).not.toBe(
      one.businessKey,
    );
    expect(businessKeyDigestsUnder({ current: "secret-a" }, "order:43").businessKey).not.toBe(
      one.businessKey,
    );
  });

  it("a rotation gives the previous secret's digest beside the current one's; none without a previous", () => {
    const rotating = businessKeyDigestsUnder({ current: "new", previous: "old" }, "order:42");

    expect(rotating.previousBusinessKey).toBe(
      businessKeyDigestsUnder({ current: "old" }, "order:42").businessKey,
    );
    expect(businessKeyDigestsUnder({ current: "new" }, "order:42")).not.toHaveProperty(
      "previousBusinessKey",
    );
  });

  it("a call's key is of its tenant, name and business key — or step — apart from each other", () => {
    const step = { tenantId: "t", name: "charge", idempotencyKey: "execution-1:pay:1" };
    const keyed = { tenantId: "t", name: "charge", businessKey: "digest", idempotencyKey: "x" };
    const keys = [
      callKeyDigestUnder("s", step),
      callKeyDigestUnder("s", { ...step, tenantId: "u" }),
      callKeyDigestUnder("s", { ...step, name: "refund" }),
      callKeyDigestUnder("s", { ...step, idempotencyKey: "execution-1:pay:2" }),
      callKeyDigestUnder("s", keyed),
      callKeyDigestUnder("s", { ...keyed, businessKey: "other" }),
      callKeyDigestUnder("t", step),
    ];

    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.every((key) => BASE64URL_43.test(key))).toBe(true);
  });

  it("a short key is a prefix from 16 to 43 characters; any other length or type is none", () => {
    const key = "a".repeat(10) + "b".repeat(33);

    expect(shortKeyOf(key, 16)).toBe(key.slice(0, 16));
    expect(shortKeyOf(key, 43)).toBe(key);
    for (const bad of [15, 44, 25.5, -1, Number.NaN, "25", undefined])
      expect(shortKeyOf(key, bad)).toBeUndefined();
  });
});

describe("#1317d: the key a call is sent with", () => {
  it("is an HMAC kept by the intent: the send, its retry and the lookup all see the one key, and shortKey is its prefix", async () => {
    const frame = outboundFrame();
    const { key } = await frame.keyIn("execution-1");
    const seen: { key: string; short: string }[] = [];
    const lookups: string[] = [];
    let attempt = 0;
    const options = {
      target: "gateway",
      operation: "charge",
      request: { amount: 10 },
      timeout: seconds(5),
      send: (call: { idempotencyKey: string; shortKey: (length: number) => string }) => {
        attempt += 1;
        seen.push({ key: call.idempotencyKey, short: call.shortKey(25) });
        // an error of unknown outcome: the intent stays pending
        return attempt === 1
          ? Promise.reject(new Error("the answer was lost"))
          : Promise.resolve({ paymentId: "p-1" });
      },
      recovery: OutboundRecovery.permanentLookup((lookup: { idempotencyKey: string }) => {
        lookups.push(lookup.idempotencyKey);
        return Reconciliation.notExecuted();
      }),
    };

    await rejectionOf(frame.send(key, options as never));
    await frame.send(key, options as never);

    expect(seen).toHaveLength(2);
    expect(seen[0]?.key).toMatch(BASE64URL_43);
    expect(seen[1]?.key).toBe(seen[0]?.key);
    expect(seen[0]?.short).toBe(seen[0]?.key.slice(0, 25));
    expect(lookups).toEqual([seen[0]?.key]);
    const stored = await frame.store.findByKey(lookupKeyOf(key));
    expect(stored?.idempotencyKey).toBe(seen[0]?.key);
    expect(JSON.stringify(stored)).not.toContain("order:42");
  });

  it("shortKey of another length is IdempotencyError.InvalidKey, not a RangeError", async () => {
    const frame = outboundFrame();
    const { key } = await frame.keyIn("execution-1");
    const refusal: unknown[] = [];

    await frame.send(key, {
      target: "gateway",
      operation: "charge",
      request: { amount: 10 },
      timeout: seconds(5),
      send: (call: { shortKey: (length: number) => string }) => {
        for (const length of [8, 44, 20.5])
          try {
            call.shortKey(length);
          } catch (error) {
            refusal.push(error);
          }
        return Promise.resolve({ paymentId: "p-1" });
      },
      recovery: OutboundRecovery.replayWithin(seconds(60)),
    } as never);

    expect(refusal).toHaveLength(3);
    for (const error of refusal) expect(error).toBeInstanceOf(IdempotencyError.InvalidKey);
  });
});
