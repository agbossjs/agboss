/**
 * #860 (design §5): an attempt lost in flight — its run stopped without its reply, its `expiresAt`
 * passed — is settled once by whoever removes or takes the message over: its files removed (its
 * call of unknown cost is its run's, recorded when its lease is taken over: `without-recovery.test.ts`);
 * the sweep removes old completed messages with their files, a page at a time, never one in flight
 * (D2). A resend that finds such an attempt takes it over and runs the skill once.
 */
import { describe, expect, it, vi } from "vitest";
import { A2A_SKILLS_EXTENSION } from "../../../src/a2a/index.js";
import { requestHashOf } from "../../../src/a2a/server/a2a-message-input.js";
import { a2aDirectMessageExpiryOf } from "../../../src/infrastructure/a2a-direct-message-expiry.js";
import {
  A2ADirectMessageRepository,
  type NewA2ADirectMessage,
} from "../../../src/infrastructure/a2a-direct-message.repository.js";
import { InMemoryA2ADirectMessageRepository } from "../../../src/infrastructure/in-memory-a2a-direct-message.repository.js";
import { InMemoryA2AFileRepository } from "../../../src/infrastructure/in-memory-a2a-file.repository.js";
import { A2AFileRepository } from "../../../src/infrastructure/a2a-file.repository.js";
import { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { replyWith, testWith } from "../../../src/testing/index.js";
import { minutes, seconds } from "../../../src/units/index.js";
import { BearerCallerResolver } from "../fixtures/bearer-caller-resolver.js";
import { DirectApplication, QuoteAgent, QuotesA2AExpose } from "../fixtures/direct.application.js";
import { rpc, text, userMessage } from "../server/rpc.js";
import { textMessage } from "../server/sdk-client.js";

const NINE = new Date("2026-01-05T09:00:00.000Z");

const lostMessage = (overrides: Partial<NewA2ADirectMessage> = {}): NewA2ADirectMessage => ({
  tenantId: "default",
  ownerId: "dana",
  messageId: "m-1",
  requestHash: "h-1",
  skill: "quote-workflow-start",
  contextId: "ctx-1",
  attemptId: "run-lost",
  startedAt: NINE,
  expiresAt: new Date(NINE.getTime() + 30_000),
  callsModel: true,
  createdAt: NINE,
  ...overrides,
});

function sweepOn(clock: VirtualClock) {
  const database = new InMemoryDatabase();
  const messages = new InMemoryA2ADirectMessageRepository(database);
  const files = new InMemoryA2AFileRepository(database);
  const deleteByOwner = vi.spyOn(files, "deleteByOwner");
  const expiry = a2aDirectMessageExpiryOf({ messages, files, clock, retention: minutes(15) });
  const sweep = () =>
    expiry.remove?.(new Date(clock.now().getTime() - minutes(15))) ?? Promise.resolve();
  return { messages, deleteByOwner, sweep };
}

describe("#860: the sweep of the direct messages", () => {
  it("a lost attempt is removed once its expiresAt passed, with its files — a second look removes nothing more", async () => {
    const clock = new VirtualClock(NINE);
    const { messages, deleteByOwner, sweep } = sweepOn(clock);
    await messages.saveIfAbsent(lostMessage());
    await clock.advance(seconds(29));
    await sweep();
    expect(await messages.findByKey(lostMessage())).toBeDefined();

    await clock.advance(seconds(1));
    await sweep();
    await sweep();

    expect(deleteByOwner.mock.calls).toEqual([[{ tenantId: "default", ownerId: "run-lost" }]]);
    expect(await messages.findByKey(lostMessage())).toBeUndefined();
  });

  it("D2: an attempt still in flight past the retention is not removed by age: its row and files stay", async () => {
    const clock = new VirtualClock(NINE);
    const { messages, deleteByOwner, sweep } = sweepOn(clock);
    const live = { expiresAt: new Date(NINE.getTime() + minutes(60)) };
    await messages.saveIfAbsent(lostMessage(live));

    await clock.advance(minutes(20));
    await sweep();

    expect(await messages.findByKey(lostMessage())).toBeDefined();
    expect(deleteByOwner).not.toHaveBeenCalled();
  });

  it("messages accepted before the retention go, with their attempts' files; younger ones stay", async () => {
    const clock = new VirtualClock(NINE);
    const { messages, deleteByOwner, sweep } = sweepOn(clock);
    const reply = { finish: "quote-workflow-finish", output: { text: "12.50" }, spentUsd: 0 };
    await messages.saveIfAbsent(lostMessage());
    await messages.completeIfInFlight(lostMessage(), "run-lost", reply, NINE);
    await clock.advance(minutes(10));
    const younger = { messageId: "m-2", attemptId: "run-2", createdAt: clock.now() };
    await messages.saveIfAbsent(
      lostMessage({ ...younger, expiresAt: new Date(clock.now().getTime() + minutes(60)) }),
    );

    await clock.advance("301s");
    await sweep();

    expect(await messages.findByKey(lostMessage())).toBeUndefined();
    expect(await messages.findByKey(lostMessage({ messageId: "m-2" }))).toBeDefined();
    expect(deleteByOwner.mock.calls).toEqual([[{ tenantId: "default", ownerId: "run-lost" }]]);
  });
});

const test = testWith(DirectApplication);
const listener = { expose: QuotesA2AExpose, callerResolver: BearerCallerResolver };
const QUOTE = { [A2A_SKILLS_EXTENSION]: { skill: "quote-workflow-start" } };

describe("#860: a resend that finds its attempt lost", () => {
  test("takes it over once: the lost attempt's files removed, then the skill run once", async ({
    a2aServer,
    app,
    clock,
    mockLlm,
  }) => {
    mockLlm(QuoteAgent).thenReturn(replyWith("12.50 EUR."));
    const { url } = await a2aServer(listener);
    const requestHash = requestHashOf(
      "quote-workflow-start",
      textMessage("m-1", "price?", { metadata: QUOTE }),
    );
    const now = clock.now();
    await app
      .resolve(A2ADirectMessageRepository)
      .saveIfAbsent(lostMessage({ requestHash, startedAt: now, createdAt: now, expiresAt: now }));
    const deleteByOwner = vi.spyOn(app.resolve(A2AFileRepository), "deleteByOwner");

    const answer = await rpc(url, "SendMessage", {
      message: userMessage("m-1", [text("price?")], { metadata: QUOTE }),
    });

    expect(answer.body.result).toMatchObject({ message: { parts: [{ text: "12.50 EUR." }] } });
    expect(deleteByOwner.mock.calls).toContainEqual([{ tenantId: "default", ownerId: "run-lost" }]);
    expect(mockLlm(QuoteAgent).requests).toHaveLength(1);
  });
});
