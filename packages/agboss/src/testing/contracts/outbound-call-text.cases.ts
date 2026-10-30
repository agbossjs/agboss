import { expect } from "vitest";
import { OutboundCallStatus } from "../../infrastructure/outbound-call.repository.js";
import type { ContractGroup } from "./define.js";
import { keyOf, leaseOf } from "./fenced-effect-data.js";
import { nulCaseName, NUL_TEXT } from "./nul-text.js";
import {
  intentOf,
  recorded,
  type OutboundCallCase,
  type OutboundCallStores,
} from "./outbound-call-data.js";

/** The outbound-call contract's texts (#521 AC4): what the framework hands over comes back as it was. */

const request = JSON.stringify({ orderId: NUL_TEXT });

const requestAndResult: OutboundCallCase = {
  name: nulCaseName("an intent's request and its result"),
  run: async ({ first, second }) => {
    const key = keyOf(await leaseOf(first));
    await recorded(first, key, { request });

    await first.calls.markCompleted(key, JSON.stringify({ receipt: NUL_TEXT }));

    expect(await second.calls.findByKey(key)).toMatchObject({
      request: intentOf(key, { request }).request,
      status: OutboundCallStatus.Completed,
      result: JSON.stringify({ receipt: NUL_TEXT }),
    });
  },
};

const failureMessage: OutboundCallCase = {
  name: nulCaseName("a failure's name, code and message"),
  run: async ({ first, second }) => {
    const key = keyOf(await leaseOf(first));
    await recorded(first, key);
    const failure = { name: NUL_TEXT, code: NUL_TEXT, message: NUL_TEXT };

    await first.calls.markFailed(key, failure);

    expect((await second.calls.findByKey(key))?.failure).toEqual(failure);
  },
};

/** The texts of one key. */
export const outboundTextCases = (): ContractGroup<OutboundCallStores> => ({
  title: "texts as they were handed over",
  cases: [requestAndResult, failureMessage],
});
