import { expect } from "vitest";
import { OutboundCallStatus } from "../../infrastructure/outbound-call.repository.js";
import { seconds } from "../../units/index.js";
import type { ContractGroup } from "./define.js";
import { keyOf, leaseOf } from "./fenced-effect-data.js";
import {
  intentOf,
  recorded,
  type OutboundCallCase,
  type OutboundCallStores,
} from "./outbound-call-data.js";

/** The outbound-call contract's writes (#505): record, read back, complete, fail, send again. */

const FAILURE = { name: "PaymentDeclinedError", code: "PaymentDeclinedError", message: "declined" };

const savedThenFound: OutboundCallCase = {
  name: "save, then find: the intent is Pending with its fields, the tenant, the name and the token, as the other instance reads it",
  run: async ({ clock, first, second }) => {
    const key = keyOf(await leaseOf(first));

    const isSaved = await first.calls.saveIfAbsent(key, intentOf(key));
    const found = await second.calls.findByKey(key);

    expect(isSaved).toBe(true);
    expect(found).toEqual({
      ...intentOf(key),
      tenantId: "default",
      name: "charge",
      status: OutboundCallStatus.Pending,
      token: 1,
      recordedAt: clock.now().toISOString(),
    });
  },
};

const unknownKeyMissing: OutboundCallCase = {
  name: "find of a key never recorded: undefined",
  run: async ({ first }) => {
    const key = keyOf(await leaseOf(first));

    expect(await first.calls.findByKey(key)).toBeUndefined();
  },
};

const duplicateRefused: OutboundCallCase = {
  name: "a second save of one key is refused (false) and the first intent is kept",
  run: async ({ first, second }) => {
    const key = keyOf(await leaseOf(first));
    await recorded(first, key);

    const isSaved = await second.calls.saveIfAbsent(key, intentOf(key, { request: "{}" }));

    expect(isSaved).toBe(false);
    expect((await first.calls.findByKey(key))?.request).toBe(intentOf(key).request);
  },
};

const completed: OutboundCallCase = {
  name: "markCompleted: Completed with its result and endedAt",
  run: async ({ clock, first, second }) => {
    const key = keyOf(await leaseOf(first));
    await recorded(first, key);

    await first.calls.markCompleted(key, '{"receipt":"r1"}');

    expect(await second.calls.findByKey(key)).toMatchObject({
      status: OutboundCallStatus.Completed,
      result: '{"receipt":"r1"}',
      endedAt: clock.now().toISOString(),
    });
  },
};

const failed: OutboundCallCase = {
  name: "markFailed: Failed with the error's name, code and message, and endedAt",
  run: async ({ clock, first }) => {
    const key = keyOf(await leaseOf(first));
    await recorded(first, key);

    await first.calls.markFailed(key, FAILURE);

    expect(await first.calls.findByKey(key)).toMatchObject({
      status: OutboundCallStatus.Failed,
      failure: FAILURE,
      endedAt: clock.now().toISOString(),
    });
  },
};

const pendingAgain: OutboundCallCase = {
  name: "markPending after a failure: Pending again at the next attempt, its failure and endedAt gone",
  run: async ({ first }) => {
    const key = keyOf(await leaseOf(first));
    await recorded(first, key);
    await first.calls.markFailed(key, FAILURE);

    await first.calls.markPending(key, 2);

    const found = await first.calls.findByKey(key);
    expect(found).toMatchObject({ status: OutboundCallStatus.Pending, attempt: 2 });
    expect(found?.failure).toBeUndefined();
    expect(found?.endedAt).toBeUndefined();
  },
};

const newerHolderReads: OutboundCallCase = {
  name: "the holder of a newer lease reads the intent recorded under the older token, and its writes carry the newer token",
  run: async ({ clock, first, second }) => {
    const old = await leaseOf(first, "execution-1", seconds(30));
    await recorded(first, keyOf(old));
    await clock.advance(seconds(31));
    const taken = await leaseOf(second, "execution-1", seconds(30));

    const found = await second.calls.findByKey(keyOf(taken));
    await second.calls.markCompleted(keyOf(taken), "{}");

    expect(found).toMatchObject({ status: OutboundCallStatus.Pending, token: 1 });
    expect(await second.calls.findByKey(keyOf(taken))).toMatchObject({ token: 2 });
  },
};

const namesApart: OutboundCallCase = {
  name: "two names of one step are two intents",
  run: async ({ first }) => {
    const lease = await leaseOf(first);
    await recorded(first, keyOf(lease, "charge"));
    await recorded(first, keyOf(lease, "notify"));

    await first.calls.markCompleted(keyOf(lease, "charge"), "{}");

    expect((await first.calls.findByKey(keyOf(lease, "notify")))?.status).toBe(
      OutboundCallStatus.Pending,
    );
  },
};

const raceOneSave: OutboundCallCase = {
  name: "two instances save one key at once: exactly one is recorded",
  run: async ({ first, second }) => {
    const key = keyOf(await leaseOf(first));

    const saves = await Promise.all([
      first.calls.saveIfAbsent(key, intentOf(key, { request: '"first"' })),
      second.calls.saveIfAbsent(key, intentOf(key, { request: '"second"' })),
    ]);

    expect(saves.filter(Boolean)).toHaveLength(1);
    const found = await first.calls.findByKey(key);
    expect(found?.request).toBe(saves[0] ? '"first"' : '"second"');
  },
};

/** The writes and reads of one key. */
export const outboundWriteCases = (): ContractGroup<OutboundCallStores> => ({
  title: "writes",
  cases: [
    savedThenFound,
    unknownKeyMissing,
    duplicateRefused,
    completed,
    failed,
    pendingAgain,
    newerHolderReads,
    namesApart,
    raceOneSave,
  ],
});
