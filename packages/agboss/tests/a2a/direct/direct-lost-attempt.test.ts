/**
 * #860 (design §5): an attempt lost in flight — its run stopped without its reply, its `expiresAt`
 * passed — is settled once by whoever removes or takes it over: one entry of unknown cost under the
 * attempt's own ledger id when its skill can call a model (none otherwise), counted by the
 * instance's tally, and its files removed; the sweep removes old messages with their files, a page
 * at a time. A resend that finds such an attempt takes it over, settles it and runs the skill once.
 */
import { describe, expect, it, vi } from "vitest";
import { A2A_SKILLS_EXTENSION } from "../../../src/a2a/index.js";
import { requestHashOf } from "../../../src/a2a/server/a2a-message-input.js";
import { CostSource } from "../../../src/finops/cost-source.js";
import { a2aDirectMessageExpiryOf } from "../../../src/infrastructure/a2a-direct-message-expiry.js";
import {
  A2ADirectMessageRepository,
  type NewA2ADirectMessage,
} from "../../../src/infrastructure/a2a-direct-message.repository.js";
import { InMemoryA2ADirectMessageRepository } from "../../../src/infrastructure/in-memory-a2a-direct-message.repository.js";
import { InMemoryA2AFileRepository } from "../../../src/infrastructure/in-memory-a2a-file.repository.js";
import {
  CostLedgerRepository,
  InMemoryCostLedgerRepository,
} from "../../../src/infrastructure/cost-ledger.repository.js";
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
  const ledger = new InMemoryCostLedgerRepository();
  const saveAll = vi.spyOn(ledger, "saveAll");
  const deleteByOwner = vi.spyOn(files, "deleteByOwner");
  const tally = { recorded: vi.fn(), unrecorded: vi.fn() };
  const expiry = a2aDirectMessageExpiryOf({
    messages,
    files,
    ledger,
    clock,
    unknownCosts: tally,
    retention: minutes(15),
  });
  const sweep = () =>
    expiry.remove?.(new Date(clock.now().getTime() - minutes(15))) ?? Promise.resolve();
  return { messages, saveAll, deleteByOwner, tally, sweep };
}

describe("#860: the sweep of the direct messages", () => {
  it("a lost attempt of a model skill: one Unknown entry, counted once, its files removed — a second look adds none", async () => {
    const clock = new VirtualClock(NINE);
    const { messages, saveAll, deleteByOwner, tally, sweep } = sweepOn(clock);
    await messages.saveIfAbsent(lostMessage());
    await clock.advance(seconds(29));
    await sweep();
    expect(saveAll).not.toHaveBeenCalled();

    await clock.advance(seconds(1));
    await sweep();
    await sweep();

    expect(saveAll).toHaveBeenCalledTimes(1);
    expect(saveAll.mock.calls[0]?.[0]).toEqual([]);
    expect(saveAll.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({
        ledgerId: "unknown:a2a-msg:default:run-lost",
        costSource: CostSource.Unknown,
        costUsd: 0,
        model: "unknown",
        caller: "a2a-message:quote-workflow-start",
      }),
    ]);
    expect(tally.recorded.mock.calls).toEqual([["quote-workflow-start", 1]]);
    expect(deleteByOwner.mock.calls).toEqual([[{ tenantId: "default", ownerId: "run-lost" }]]);
    expect(await messages.findByKey(lostMessage())).toBeUndefined();
  });

  it("a lost attempt of a skill that calls no model records no Unknown entry", async () => {
    const clock = new VirtualClock(NINE);
    const { messages, saveAll, tally, sweep } = sweepOn(clock);
    await messages.saveIfAbsent(lostMessage({ callsModel: false }));

    await clock.advance(seconds(30));
    await sweep();

    expect(saveAll).not.toHaveBeenCalled();
    expect(tally.recorded).not.toHaveBeenCalled();
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
  test("takes it over once: the lost attempt's Unknown entry, then the skill run once", async ({
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
    const saveAll = vi.spyOn(app.resolve(CostLedgerRepository), "saveAll");

    const answer = await rpc(url, "SendMessage", {
      message: userMessage("m-1", [text("price?")], { metadata: QUOTE }),
    });

    expect(answer.body.result).toMatchObject({ message: { parts: [{ text: "12.50 EUR." }] } });
    const unknown = saveAll.mock.calls.flatMap(([, entries]) =>
      entries.filter((entry) => entry.costSource === CostSource.Unknown),
    );
    expect(unknown.map((entry) => entry.ledgerId)).toEqual(["unknown:a2a-msg:default:run-lost"]);
    expect(mockLlm(QuoteAgent).requests).toHaveLength(1);
  });
});
