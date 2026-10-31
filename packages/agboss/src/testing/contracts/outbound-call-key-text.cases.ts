import { expect } from "vitest";
import { InvalidBusinessKeyError } from "../../infrastructure/fenced-effect-key.js";
import type { FencedEffectKey } from "../../infrastructure/fenced-effect.repository.js";
import { OutboundCallStatus } from "../../infrastructure/outbound-call.repository.js";
import type { ContractGroup } from "./define.js";
import { keyOf, leaseOf, rejectionOf } from "./fenced-effect-data.js";
import { bytesOf, REFUSED_BUSINESS_KEYS, ROUND_TRIP_KEYS } from "./key-text-data.js";
import {
  intentOf,
  recorded,
  type OutboundCallCase,
  type OutboundCallStores,
} from "./outbound-call-data.js";

/** Every method a key enters an outbound-call store through. */
const KEYED_METHODS: readonly (readonly [
  string,
  (stores: OutboundCallStores, key: FencedEffectKey) => Promise<unknown>,
])[] = [
  ["findByKey", (stores, key) => stores.calls.findByKey(key)],
  ["saveIfAbsent", (stores, key) => stores.calls.saveIfAbsent(key, intentOf(key))],
  [
    "markPending",
    (stores, key) =>
      stores.calls.markPending(
        key,
        { status: OutboundCallStatus.Pending, attempt: 1, attemptOwner: "owner-1" },
        { attempt: 2, attemptOwner: "owner-2" },
      ),
  ],
  ["markCompleted", (stores, key) => stores.calls.markCompleted(key, "owner-1", '"done"')],
  [
    "markFailed",
    (stores, key) =>
      stores.calls.markFailed(key, "owner-1", { name: "E", code: "E", message: "failed" }),
  ],
];

const roundTrip: OutboundCallCase = {
  name: "#538: business keys of many scripts — CJK, Cyrillic, Hebrew, emoji, astral, 200 code units — come back byte for byte, on the other instance, each its own intent",
  run: async ({ first, second }) => {
    const lease = await leaseOf(first);
    const keyed = (businessKey: string): FencedEffectKey => ({ ...keyOf(lease), businessKey });

    for (const businessKey of ROUND_TRIP_KEYS) await recorded(first, keyed(businessKey));
    for (const businessKey of ROUND_TRIP_KEYS) {
      const found = await second.calls.findByKey(keyed(businessKey));
      expect({ businessKey, bytes: bytesOf(found?.businessKey ?? "") }).toEqual({
        businessKey,
        bytes: bytesOf(businessKey),
      });
      expect(
        await second.calls.saveIfAbsent(keyed(businessKey), intentOf(keyed(businessKey))),
      ).toBe(false);
    }
  },
};

const refusedByHand: OutboundCallCase = {
  name: "#538: a key built by hand whose business key breaks a rule is InvalidBusinessKeyError naming the rule at every method — findByKey, saveIfAbsent, markPending, markCompleted, markFailed —, never the key; nothing recorded",
  run: async ({ first, second }) => {
    const lease = await leaseOf(first);

    for (const [rule, businessKey] of REFUSED_BUSINESS_KEYS) {
      for (const [method, call] of KEYED_METHODS) {
        const refused = await rejectionOf(call(first, { ...keyOf(lease), businessKey }));
        expect({ method, rule, isRefused: refused instanceof InvalidBusinessKeyError }).toEqual({
          method,
          rule,
          isRefused: true,
        });
        expect(refused).toMatchObject({ rule });
        expect((refused as Error).message).not.toContain(businessKey);
      }
    }
    expect(
      await second.calls.findAllByTenantIdAndRootExecutionId("default", "execution-1"),
    ).toEqual([]);
  },
};

/** The key-text cases of the outbound-call contract (#538). */
export const outboundKeyTextCases = (): ContractGroup<OutboundCallStores> => ({
  title: "the text of a business key",
  cases: [roundTrip, refusedByHand],
});
