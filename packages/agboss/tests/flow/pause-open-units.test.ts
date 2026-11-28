/**
 * #1356 (shards `cancel-x-pauses` and `pauses`) — how a pause step opens its record and picks its channel
 * (`pause-open.ts`), on their own: which targets look for the record first on a re-entry, what the project's hooks
 * are asked, what a `@ChannelSelector` is given and what it may answer.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChannelSelectError,
  chosenChannel,
  openedPause,
  type PauseStepSite,
} from "../../src/flow/runtime/pause-open.js";
import type { PauseChannel, PauseTarget } from "../../src/flow/runtime/pause-channel.js";
import { PauseKind } from "../../src/infrastructure/pause-record.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { pauseOf } from "../../src/testing/contracts/paused-execution-data.js";
import { seconds, workingHours } from "../../src/units/index.js";

const made = vi.hoisted(() => ({ calls: [] as unknown[][] }));
vi.mock("../../src/flow/runtime/pause-record-made.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/flow/runtime/pause-record-made.js")>()),
  newRecordOf: (...args: unknown[]) => {
    made.calls.push(args);
    return Promise.resolve({ ...pauseOf("p-new") });
  },
}));

class ChannelA {
  readonly mark = "a";
}
class ChannelB {
  readonly mark = "b";
}
const channelA = { cls: ChannelA, name: "a" } as never;
const channelB = { cls: ChannelB, name: "b" } as never;
const AT = new Date("2026-11-20T10:00:00.000Z");

const targetOf = (changes: Partial<PauseTarget> = {}): PauseTarget =>
  ({
    name: "refund",
    cls: class Refund {
      readonly mark = "refund";
    },
    kind: "tool-approval",
    channels: new Map([
      ["a", channelA],
      ["b", channelB],
    ]),
    ...changes,
  }) as PauseTarget;

const trailEntry = { action: "opened" as const, at: AT, target: "refund" };
const thrownBy = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("#1356: the channel a new pause is sent through", () => {
  it("is the only channel, or none for an owner's target: no selector is asked", async () => {
    const select = vi.fn();

    expect(
      await chosenChannel(
        targetOf({ channels: new Map([["a", channelA]]), select }),
        { input: {} },
        {
          trail: [],
        },
      ),
    ).toBe(channelA);
    expect(
      await chosenChannel(targetOf({ channels: new Map(), select }), { input: {} }, { trail: [] }),
    ).toBeUndefined();
    expect(select).not.toHaveBeenCalled();
  });

  it("of several channels with no selector is refused, naming the target and the count, never the pause's data", async () => {
    const error = await thrownBy(() =>
      chosenChannel(targetOf(), { input: { secret: "x" } }, { trail: [] }),
    );

    expect(error).toBeInstanceOf(ChannelSelectError);
    expect(error).toHaveProperty("name", "ChannelSelectError");
    expect(error).toHaveProperty(
      "message",
      "pause target refund: 2 channels and no @ChannelSelector",
    );
  });

  it("of several is the one whose class the selector names", async () => {
    const select = vi.fn((_context: unknown) => Promise.resolve(ChannelB));
    const first = vi.fn((_context: unknown) => Promise.resolve(ChannelA));

    expect(await chosenChannel(targetOf({ select }), { input: {} }, { trail: [] })).toBe(channelB);
    expect(await chosenChannel(targetOf({ select: first }), { input: {} }, { trail: [] })).toBe(
      channelA,
    );
  });

  it("is asked with the input, the tool call, the assignees, a copy of the deadline and copies of the trail — each only when there", async () => {
    const select = vi.fn((_context: unknown) => Promise.resolve(ChannelA));
    const toolCall = { callId: "c-1", tool: "refund" };
    const expiresAt = new Date("2026-11-21T10:00:00.000Z");

    await chosenChannel(
      targetOf({ select }),
      { input: { amount: 5 }, toolCall },
      {
        assignees: ["ann"],
        expiresAt,
        trail: [trailEntry],
      },
    );
    await chosenChannel(targetOf({ select }), { input: { amount: 5 } }, { trail: [] });

    const [full, bare] = select.mock.calls.map(([context]) => context as Record<string, unknown>);
    expect(full).toStrictEqual({
      input: { amount: 5 },
      assignees: ["ann"],
      toolCall,
      expiresAt,
      trail: [trailEntry],
    });
    expect(full?.expiresAt).not.toBe(expiresAt);
    expect((full?.trail as unknown[])[0]).not.toBe(trailEntry);
    expect(bare).toStrictEqual({ input: { amount: 5 }, trail: [] });
  });

  it("of a selector that fails is refused naming the target, the failure its cause", async () => {
    const failure = new Error("boom");

    const error = await thrownBy(() =>
      chosenChannel(
        targetOf({ select: () => Promise.reject(failure) }),
        { input: {} },
        { trail: [] },
      ),
    );

    expect(error).toBeInstanceOf(ChannelSelectError);
    expect(error).toHaveProperty("message", "pause target refund: its @ChannelSelector failed");
    expect(error).toHaveProperty("cause", failure);
  });

  it("of a selector that names a class no channel serves is refused", async () => {
    const error = await thrownBy(() =>
      chosenChannel(
        targetOf({
          select: () =>
            Promise.resolve(
              class Other {
                readonly mark = "other";
              },
            ),
        }),
        { input: {} },
        { trail: [] },
      ),
    );

    expect(error).toBeInstanceOf(ChannelSelectError);
    expect(error).toHaveProperty(
      "message",
      "pause target refund: its @ChannelSelector named a class that serves no channel of it",
    );
  });
});

describe("#1356: the pause a step opens", () => {
  const frame = {
    execution: { executionId: "root-1", tenant: { tenantId: "acme" } },
    step: { idempotencyKey: "key-1" },
  };
  const question = {
    kind: PauseKind.Approval,
    step: "refund-agent",
    input: { amount: 5 },
    toolCall: { callId: "c-1", tool: "refund" },
  };
  const siteOf = (target: PauseTarget, found?: unknown) => {
    const clock = new VirtualClock();
    const findBy = vi.fn((..._ids: string[]) => Promise.resolve(found));
    const findOrCreate = vi.fn((record: unknown) => Promise.resolve(record));
    const site = {
      pauses: {
        findByTenantIdAndRootExecutionIdAndStepKey: findBy,
        findOrCreateByStepKey: findOrCreate,
      },
      target,
      frame,
      signal: undefined,
      clock,
    } as never;
    return { site, findBy, findOrCreate, clock };
  };

  beforeEach(() => {
    made.calls.length = 0;
  });

  it.each([
    ["a working-time deadline", { timeout: workingHours(2) }],
    ["a channel selector", { select: () => Promise.resolve(ChannelA) }],
    ["an assign hook", { assign: () => Promise.resolve(["ann"]) }],
    ["a resolveTimeout hook", { resolveTimeout: () => Promise.resolve(seconds(30)) }],
  ])(
    "a target with %s looks for the record first: a re-entry gets it, nothing asks the project's code again",
    async (_name, changes) => {
      const existing = pauseOf("p-existing");
      const { site, findBy, findOrCreate } = siteOf(targetOf(changes), existing);

      expect(await openedPause(site, question)).toBe(existing);

      expect(findBy).toHaveBeenCalledWith("acme", "root-1", "key-1");
      expect(made.calls).toEqual([]);
      expect(findOrCreate).not.toHaveBeenCalled();
    },
  );

  it("a target with none of them makes the record without looking, and the store decides a race", async () => {
    const { site, findBy, findOrCreate } = siteOf(targetOf({ timeout: seconds(60) }));

    const opened = await openedPause(site, question);

    expect(findBy).not.toHaveBeenCalled();
    expect(findOrCreate).toHaveBeenCalledOnce();
    expect(opened).toEqual(pauseOf("p-new"));
    expect(made.calls).toHaveLength(1);
  });

  it("asks the project's hooks with the question and an opened entry of the trail, the assignees to the timeout's hook", async () => {
    const assign = vi.fn((_context: unknown) => Promise.resolve(["ann"]));
    const resolveTimeout = vi.fn((_context: unknown) => Promise.resolve(seconds(30)));
    const { site, clock } = siteOf(targetOf({ assign, resolveTimeout }));

    await openedPause(site, question);

    const now = clock.now();
    const trail = [{ action: "opened", at: now, target: "refund" }];
    expect(assign.mock.calls[0]?.[0]).toStrictEqual({
      input: { amount: 5 },
      toolCall: question.toolCall,
      trail,
    });
    expect(resolveTimeout.mock.calls[0]?.[0]).toStrictEqual({
      input: { amount: 5 },
      assignees: ["ann"],
      toolCall: question.toolCall,
      trail,
    });
    const [, , , , , , , hooks] = made.calls[0] ?? [];
    expect(hooks).toStrictEqual({ assignees: ["ann"], timeout: seconds(30) });
  });

  it("hands the record's maker the channel choice of its target", async () => {
    const select = vi.fn((_context: unknown) => Promise.resolve(ChannelB));
    const { site } = siteOf(targetOf({ select }));

    await openedPause(site, question);

    const choose = made.calls[0]?.[6] as (opening: unknown) => Promise<unknown>;
    expect(await choose({ trail: [] })).toBe(channelB);
  });
});
