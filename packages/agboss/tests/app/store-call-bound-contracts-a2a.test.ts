/**
 * #928 AC2 — the A2A stores' unknown outcomes: the accept of a task and the keeping of a direct
 * message's reply take effect and are never answered; the caller's request fails (`-32603`, nothing
 * of the store on the wire) and the resend or the expiry finds the store as it is.
 */
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { A2A_SKILLS_EXTENSION } from "../../src/a2a/index.js";
import { STORE_CALL_BOUND } from "../../src/app/lease-fence.js";
import { A2ADirectMessageRepository } from "../../src/infrastructure/a2a-direct-message.repository.js";
import { A2ATaskRepository } from "../../src/infrastructure/a2a-task.repository.js";
import { InMemoryA2ADirectMessageRepository } from "../../src/infrastructure/in-memory-a2a-direct-message.repository.js";
import { InMemoryA2ATaskRepository } from "../../src/infrastructure/in-memory-a2a-task.repository.js";
import { callTool, replyWith, testWith } from "../../src/testing/index.js";
import { seconds } from "../../src/units/index.js";
import { BearerCallerResolver } from "../a2a/fixtures/bearer-caller-resolver.js";
import {
  DirectApplication,
  QuoteAgent,
  QuotesA2AExpose,
} from "../a2a/fixtures/direct.application.js";
import { OrdersA2AExpose, OrdersApplication } from "../a2a/fixtures/task.application.js";
import { errorOf, rpc, text, userMessage } from "../a2a/server/rpc.js";
import { until } from "../helpers/until.js";
import { Charge, Clerk, resetRecovery } from "../infrastructure/fixtures/recovery.workflow.js";
import { appliedThenSilent, silent } from "./fixtures/bound-stubs.js";

beforeEach(() => {
  resetRecovery();
});
afterEach(() => vi.restoreAllMocks());

const orders = testWith(OrdersApplication);
const quotes = testWith(DirectApplication);
const QUOTE = { [A2A_SKILLS_EXTENSION]: { skill: "quote-workflow-start" } };
const quote = (messageId: string) => ({
  message: userMessage(messageId, [text("price of sku-1?")], { metadata: QUOTE }),
});
const KEY = { tenantId: "default", ownerId: "dana", messageId: "m-1" };

describe("#928 AC2: an A2A accept (saveIfAbsent) unanswered", () => {
  orders(
    "AC2: -32603; the resend of the messageId gets the same task, one execution",
    async ({ a2aServer, app, clock, mockLlm }) => {
      mockLlm(Clerk).thenReturn(callTool(Charge, { text: "10 USD" }));
      const { url } = await a2aServer({
        expose: OrdersA2AExpose,
        callerResolver: BearerCallerResolver,
      });
      const accept = appliedThenSilent(
        vi.spyOn(InMemoryA2ATaskRepository.prototype, "saveIfAbsent"),
      );
      const send = { message: userMessage("m-1", [text("go")]) };

      const first = rpc(url, "SendMessage", send);
      await until(() => accept.mock.calls.length >= 1, "the accept reached the store");
      await clock.advance(STORE_CALL_BOUND);
      const failed = await first;

      expect(errorOf(failed).code).toBe(-32603);
      // nothing of the store on the wire (#807): a fixed text
      expect(errorOf(failed).message).toBe("the request failed");
      const tasks = app.resolve(A2ATaskRepository);
      const kept = await tasks.findByMessage({ ...KEY, messageId: "m-1" });
      const resent = await rpc(url, "SendMessage", send);

      expect(resent.body.error).toBeUndefined();
      expect(JSON.stringify(resent.body.result)).toContain(kept?.taskId ?? "no task kept");
      const { tasks: all } = await tasks.list({
        tenantId: "default",
        ownerId: "dana",
        pageSize: 10,
      });
      expect(all).toHaveLength(1);
      expect(mockLlm(Clerk).requests).toHaveLength(1);
    },
  );
});

/** The `Message` text of a direct reply's answer. */
const replyTextOf = (answer: { readonly body: Record<string, unknown> }): string =>
  JSON.stringify(answer.body.result ?? answer.body.error);

describe("#928 AC2: a direct message's completeIfInFlight unanswered", () => {
  quotes(
    "AC2: the reply was kept: the attempt's caller fails; a resend reads the kept reply, no second run, one reply",
    async ({ a2aServer, app, clock, mockLlm }) => {
      mockLlm(QuoteAgent).thenReturn(replyWith("12.50 EUR."));
      const { url } = await a2aServer({
        expose: QuotesA2AExpose,
        callerResolver: BearerCallerResolver,
      });
      const complete = appliedThenSilent(
        vi.spyOn(InMemoryA2ADirectMessageRepository.prototype, "completeIfInFlight"),
      );

      const first = rpc(url, "SendMessage", quote("m-1"));
      await until(() => complete.mock.calls.length >= 1, "the reply reached the store");
      await clock.advance(STORE_CALL_BOUND);
      const failed = await first;

      expect(errorOf(failed).code).toBe(-32603);
      const resent = await rpc(url, "SendMessage", quote("m-1"));
      expect(replyTextOf(resent)).toContain("12.50 EUR.");
      const kept = await app.resolve(A2ADirectMessageRepository).findByKey(KEY);
      expect(kept?.reply?.finish).toBe("quote-workflow-finish");
      expect(mockLlm(QuoteAgent).requests).toHaveLength(1);
    },
  );

  quotes(
    "AC2: the reply was not kept: past expiresAt a resend retakes the attempt once; one reply, kept and replayed",
    async ({ a2aServer, app, clock, mockLlm }) => {
      mockLlm(QuoteAgent).thenReturn(replyWith("12.50 EUR."), replyWith("13.00 EUR."));
      const { url } = await a2aServer({
        expose: QuotesA2AExpose,
        callerResolver: BearerCallerResolver,
      });
      const complete = vi
        .spyOn(InMemoryA2ADirectMessageRepository.prototype, "completeIfInFlight")
        .mockImplementationOnce(() => silent());

      const first = rpc(url, "SendMessage", quote("m-1"));
      await until(() => complete.mock.calls.length >= 1, "the reply reached the store");
      await clock.advance(STORE_CALL_BOUND);
      expect(errorOf(await first).code).toBe(-32603);

      // the row is still in flight under the lost attempt: the resend waits for its expiry, then takes it over
      const resend = rpc(url, "SendMessage", quote("m-1"));
      const state = { isDone: false };
      void resend.then(() => (state.isDone = true));
      for (let step = 0; step < 40 && !state.isDone; step += 1) {
        await clock.advance(seconds(1));
        await new Promise((resolve) => setImmediate(resolve));
      }
      const retaken = await resend;

      expect(replyTextOf(retaken)).toContain("13.00 EUR.");
      const again = await rpc(url, "SendMessage", quote("m-1"));
      expect(replyTextOf(again)).toContain("13.00 EUR.");
      const kept = await app.resolve(A2ADirectMessageRepository).findByKey(KEY);
      expect(kept?.reply?.finish).toBe("quote-workflow-finish");
      expect(mockLlm(QuoteAgent).requests).toHaveLength(2);
    },
  );
});
