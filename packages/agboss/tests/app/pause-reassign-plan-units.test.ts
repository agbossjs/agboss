/**
 * #1307d, #1356 (shard `pauses`) — what a reassignment comes to (`pause-reassign-plan.ts`), on its own: the target and
 * channel it goes to and the refusals of a destination that cannot take the pause (each with its own message), who
 * the pause is for after it, the limits checked before anything, a deadline alone that is no reassignment, and the
 * change the store is given — in place or a replacement, an operator's or an expiry's — with exact values.
 */
import { describe, expect, it, vi } from "vitest";
import { ExternalTask, ToolApproval } from "../../src/channels/pause-targets.js";
import { PauseError } from "../../src/core/error-families/pause-errors.js";
import { isReached } from "../../src/app/pause-limits.js";
import { planOf, type ReassignFacts } from "../../src/app/pause-reassign-plan.js";
import { ChannelSelectError } from "../../src/flow/runtime/pause-open.js";
import type { PauseChannel, PauseTarget } from "../../src/flow/runtime/pause-channel.js";
import { pauseKeyOf, type PauseRecord } from "../../src/infrastructure/pause-record.js";
import { pauseOf } from "../../src/testing/contracts/paused-execution-data.js";
import { PauseRespondent } from "../../src/pause/respondent.js";
import { hours, seconds } from "../../src/units/index.js";

const NOW = new Date("2026-01-05T10:00:00.000Z");

@ToolApproval({
  name: "alpha-tool-approval",
  description: "alpha",
  respondent: PauseRespondent.Delegate,
  timeout: hours(1),
})
class Alpha {
  readonly mark = "alpha";
}
@ToolApproval({
  name: "beta-tool-approval",
  description: "beta",
  respondent: PauseRespondent.Owner,
  timeout: hours(2),
})
class Beta {
  readonly mark = "beta";
}
class Plain {
  readonly mark = "plain";
}
class Dto {
  readonly mark = "dto";
}
@ExternalTask({
  name: "gamma-external-task",
  description: "gamma",
  respondent: PauseRespondent.Delegate,
  timeout: hours(1),
  input: Dto,
  output: Dto,
})
class Gamma {
  readonly mark = "gamma";
}
class ChanOne {
  readonly mark = "one";
}
class ChanTwo {
  readonly mark = "two";
}
class ChanBeta {
  readonly mark = "beta-channel";
}

const chanOf = (name: string, cls: PauseChannel["cls"]): PauseChannel =>
  ({ name, cls, sender: {} }) as never;
const chanOne = chanOf("one-channel", ChanOne);
const chanTwo = chanOf("two-channel", ChanTwo);
const chanBeta = chanOf("beta-channel", ChanBeta);

const alpha = (changes: Partial<PauseTarget> = {}): PauseTarget => ({
  name: "alpha-tool-approval",
  cls: Alpha,
  kind: "tool-approval",
  respondent: PauseRespondent.Delegate,
  channels: new Map([["one-channel", chanOne]]),
  escalatesTo: ["beta-tool-approval", "gamma-external-task"],
  ...changes,
});
const beta = (changes: Partial<PauseTarget> = {}): PauseTarget => ({
  name: "beta-tool-approval",
  cls: Beta,
  kind: "tool-approval",
  respondent: PauseRespondent.Owner,
  channels: new Map([["beta-channel", chanBeta]]),
  ...changes,
});
const gamma = (): PauseTarget => ({
  name: "gamma-external-task",
  cls: Gamma,
  kind: "external-task",
  respondent: PauseRespondent.Delegate,
  channels: new Map(),
});

const PAUSE: PauseRecord = {
  ...pauseOf("p-1"),
  target: "alpha-tool-approval",
  channel: "one-channel",
  assignees: ["ann"],
  expiresAt: new Date("2026-01-05T12:00:00.000Z"),
};
const KEY = pauseKeyOf(PAUSE.tenantId, PAUSE.pauseId);

const partsOf = (targets: readonly PauseTarget[] = [alpha(), beta(), gamma()]) =>
  ({
    deps: { config: { name: PAUSE.workflow }, graph: { nodes: new Map() }, targets },
    clock: { now: () => NOW },
  }) as never;

const planned = (
  ask: Partial<ReassignFacts> = {},
  pause: PauseRecord = PAUSE,
  from: PauseTarget = alpha(),
  targets?: readonly PauseTarget[],
) => planOf(partsOf(targets), pause, from, { isExpiry: false, ...ask });

const refused = async (run: Promise<unknown>) => {
  try {
    await run;
  } catch (error) {
    return error as Error;
  }
  throw new Error("not refused");
};

const withTrail = (...actions: ("reassigned" | "timeout-changed")[]): PauseRecord => ({
  ...PAUSE,
  trail: [
    ...PAUSE.trail,
    ...actions.map((action) => ({ action, at: NOW, target: "alpha-tool-approval" }) as never),
  ],
});

describe("#1307d: where a reassignment goes", () => {
  it("with nothing asked of the target is the pause's own: in place, on its own channel, for its own assignees, the deadline kept", async () => {
    const plan = await planned({ actor: { id: "ops" }, reason: "look again" });

    expect(plan.target.name).toBe("alpha-tool-approval");
    expect(plan.channel).toBe(chanOne);
    expect(plan.assignees).toEqual(["ann"]);
    expect(plan.isInPlace).toBe(true);
    expect(plan.deadline).toBeUndefined();
    expect(plan.change).toStrictEqual({
      seen: { trailLength: 1, isSent: false, assignees: ["ann"], expiresAt: PAUSE.expiresAt },
      assignees: ["ann"],
      actor: { id: "ops" },
      reason: "look again",
    });
  });

  it("naming the pause's own class is the same as naming nothing", async () => {
    const plan = await planned({ target: Alpha });

    expect(plan.isInPlace).toBe(true);
    expect(plan.target.name).toBe("alpha-tool-approval");
  });

  it("an owner's pause with no channel stays without one; a channel a deploy removed refuses the call naming it", async () => {
    const owner = await planned({ assignees: ["bob"] }, { ...PAUSE, channel: undefined });
    const error = await refused(planned({}, { ...PAUSE, channel: "removed-channel" }));

    expect(owner.channel).toBeUndefined();
    expect(error).toBeInstanceOf(PauseError.IncompatibleTarget);
    expect(error.message).toBe(`pause ${KEY}: its channel is no longer in this application`);
  });

  it("to a target the source escalates to is a replacement: a new id, the destination's name, respondent and channel, the limits it offers", async () => {
    const target = beta({ escalationLimits: { maxExtensions: 2, maxReassignments: 3 } });
    const plan = await planned({ target: Beta }, PAUSE, alpha(), [alpha(), target, gamma()]);

    expect(plan.isInPlace).toBe(false);
    expect(plan.target).toBe(target);
    expect(plan.channel).toBe(chanBeta);
    expect(plan.assignees).toBeUndefined();
    expect(plan.change).toMatchObject({
      to: {
        target: "beta-tool-approval",
        respondent: PauseRespondent.Owner,
        channel: "beta-channel",
        limits: { escalationLimits: { maxExtensions: 2, maxReassignments: 3 } },
      },
    });
    expect((plan.change as { pauseId: string }).pauseId).toMatch(/^[0-9a-f]{32}$/);
    expect(plan.limits).toMatchObject({ maxExtensions: 2, maxReassignments: 3 });
  });

  it("to a target the source does not list in escalatesTo, or no target of the workflow, is refused with the reason", async () => {
    const closed = alpha({ escalatesTo: [] });
    const open = alpha({ escalatesTo: undefined });

    for (const from of [closed, open]) {
      const error = await refused(planned({ target: Beta }, PAUSE, from));
      expect(error).toBeInstanceOf(PauseError.IncompatibleTarget);
      expect(error.message).toBe(
        `pause ${KEY}: the target is not one this pause's target escalates to`,
      );
    }
    const unknown = await refused(planned({ target: Plain }));
    expect(unknown.message).toBe(
      `pause ${KEY}: the target is not one this pause's target escalates to`,
    );
    const noTargets = await refused(
      planOf(
        {
          deps: { config: { name: PAUSE.workflow }, graph: { nodes: new Map() } },
          clock: { now: () => NOW },
        } as never,
        PAUSE,
        alpha(),
        { isExpiry: false, target: Beta },
      ),
    );
    expect(noTargets.message).toBe(
      `pause ${KEY}: the target is not one this pause's target escalates to`,
    );
  });

  it("to a target of another kind or other DTOs is refused with the reason", async () => {
    const error = await refused(planned({ target: Gamma }));

    expect(error).toBeInstanceOf(PauseError.IncompatibleTarget);
    expect(error.message).toBe(`pause ${KEY}: the target is of another kind or takes other DTOs`);
  });

  it("the target of an undeclared class that the source lists is refused as of another kind too", async () => {
    const fake = { ...beta(), cls: Plain, name: "plain-tool-approval" } as PauseTarget;
    const from = alpha({ escalatesTo: ["plain-tool-approval"] });

    const error = await refused(planned({ target: Plain }, PAUSE, from, [from, fake]));

    expect(error.message).toBe(`pause ${KEY}: the target is of another kind or takes other DTOs`);
  });
});

describe("#1307d: the channel a reassigned pause is asked on", () => {
  const two = (): PauseTarget =>
    alpha({
      channels: new Map([
        ["one-channel", chanOne],
        ["two-channel", chanTwo],
      ]),
    });

  it("a channel the call names must serve the destination; the pause's own name keeps it in place, another is a replacement", async () => {
    const same = await planned({ channel: ChanOne }, PAUSE, two(), [two()]);
    const other = await planned({ channel: ChanTwo }, PAUSE, two(), [two()]);
    const error = await refused(planned({ channel: ChanBeta }));

    expect(same.channel).toBe(chanOne);
    expect(same.isInPlace).toBe(true);
    expect(other.channel).toBe(chanTwo);
    expect(other.isInPlace).toBe(false);
    expect(other.change).toMatchObject({ to: { channel: "two-channel" } });
    expect(error).toBeInstanceOf(PauseError.IncompatibleTarget);
    expect(error.message).toBe(`pause ${KEY}: the channel does not serve the target`);
  });

  it("a moved pause is asked on the destination's only channel, or on its selector's pick with what the pause has so far", async () => {
    const select = vi.fn((_context: unknown) => Promise.resolve(ChanTwo));
    const picking = beta({
      channels: new Map([
        ["beta-channel", chanBeta],
        ["two-channel", chanTwo],
      ]),
      select,
    });

    const plan = await planned(
      { target: Beta, assignees: ["bob"], timeout: seconds(60) },
      PAUSE,
      alpha(),
      [alpha(), picking],
    );

    expect(plan.channel).toBe(chanTwo);
    expect(select.mock.calls[0]?.[0]).toStrictEqual({
      input: PAUSE.input,
      toolCall: PAUSE.toolCall,
      assignees: ["bob"],
      expiresAt: new Date(NOW.getTime() + 60_000),
      trail: PAUSE.trail,
    });
    const error = await refused(
      planned({ target: Beta }, PAUSE, alpha(), [
        alpha(),
        beta({
          channels: new Map([
            ["beta-channel", chanBeta],
            ["two-channel", chanTwo],
          ]),
        }),
      ]),
    );
    expect(error).toBeInstanceOf(ChannelSelectError);
  });

  it("with the pause's own deadline kept, a selector is told it; with none and no assignees, it is told neither", async () => {
    const select = vi.fn((_context: unknown) => Promise.resolve(ChanTwo));
    const picking = beta({
      channels: new Map([
        ["beta-channel", chanBeta],
        ["two-channel", chanTwo],
      ]),
      select,
      timeout: undefined,
    });
    const from = alpha({ escalatesTo: ["beta-tool-approval"] });
    const unbounded = {
      ...PAUSE,
      assignees: undefined,
      expiresAt: undefined,
      escalationLimits: {},
    };

    await planned({ target: Beta }, unbounded, from, [from, picking]);

    expect(select.mock.calls[0]?.[0]).toStrictEqual({
      input: PAUSE.input,
      toolCall: PAUSE.toolCall,
      trail: PAUSE.trail,
    });
  });
});

describe("#1307d: who the pause is for after it", () => {
  it("is the list the call gives, none for an empty list, else the destination's `assign`, else what it had on the same target", async () => {
    const assign = vi.fn((_context: unknown) => Promise.resolve(["carol"]));

    const given = await planned({ assignees: ["bob", "dave"] });
    const emptied = await planned({ assignees: [] });
    const hooked = await planned({}, PAUSE, alpha({ assign: assign }));
    const moved = await planned({ target: Beta });

    expect(given.assignees).toEqual(["bob", "dave"]);
    expect(emptied.assignees).toBeUndefined();
    expect(hooked.assignees).toEqual(["carol"]);
    expect(assign.mock.calls[0]?.[0]).toStrictEqual({
      input: PAUSE.input,
      toolCall: PAUSE.toolCall,
      trail: PAUSE.trail,
    });
    expect(moved.assignees).toBeUndefined();
  });

  it("the destination's `assign` of a moved pause is asked too, and what it gives is the pause's", async () => {
    const assign = vi.fn((_context: unknown) => Promise.resolve(["erin"]));

    const plan = await planned({ target: Beta }, PAUSE, alpha(), [
      alpha(),
      beta({ assign: assign }),
    ]);

    expect(plan.assignees).toEqual(["erin"]);
    expect(plan.change).toMatchObject({ assignees: ["erin"] });
  });
});

describe("#1307d: the limits a reassignment meets first", () => {
  const limited = (
    escalationLimits: PauseRecord["escalationLimits"],
    pause = PAUSE,
  ): PauseRecord => ({
    ...pause,
    escalationLimits,
  });

  it("maxReassignments reached refuses the call, naming the limit; one short of it does not", async () => {
    const reached = limited({ maxReassignments: 1 }, withTrail("reassigned"));
    const short = limited({ maxReassignments: 2 }, withTrail("reassigned"));

    const error = await refused(planned({}, reached));

    expect(error).toBeInstanceOf(PauseError.EscalationLimitExceeded);
    expect(error.message).toBe(`pause ${KEY}: its maxReassignments limit is reached`);
    expect((await planned({}, short)).isInPlace).toBe(true);
    expect((await planned({}, limited({}, withTrail("reassigned")))).isInPlace).toBe(true);
  });

  it("maxExtensions reached refuses a call that sets a deadline, naming the limit; an expiry's and a call with none are not counted", async () => {
    const reached = limited({ maxExtensions: 1 }, withTrail("timeout-changed"));
    const ask = { assignees: ["bob"], timeout: seconds(60) };

    const error = await refused(planned(ask, reached));

    expect(error).toBeInstanceOf(PauseError.EscalationLimitExceeded);
    expect(error.message).toBe(`pause ${KEY}: its maxExtensions limit is reached`);
    expect((await planned({ assignees: ["bob"] }, reached)).isInPlace).toBe(true);
    expect((await planned({ ...ask, isExpiry: true }, reached)).isInPlace).toBe(true);
    expect(
      (await planned(ask, limited({ maxExtensions: 2 }, withTrail("timeout-changed")))).isInPlace,
    ).toBe(true);
  });

  it("a move is held to the destination's counts too: the smaller of the two", async () => {
    const reached = limited({ maxReassignments: 5 }, withTrail("reassigned"));
    const tight = beta({ escalationLimits: { maxReassignments: 1 } });

    const error = await refused(
      planned({ target: Beta }, reached, alpha(), [alpha(), tight, gamma()]),
    );

    expect(error.message).toBe(`pause ${KEY}: its maxReassignments limit is reached`);
  });
});

describe("#1307d: a deadline alone", () => {
  it("on the pause's own target is setPauseTimeout's change, not a reassignment's — unless it comes with anything else or from an expiry", async () => {
    const error = await refused(planned({ timeout: seconds(60) }));

    expect(error).toBeInstanceOf(PauseError.InvalidTimeout);
    expect(error.message).toBe(
      `pause ${KEY}: a deadline alone is setPauseTimeout's change, not a reassignment's`,
    );
    for (const ask of [
      { timeout: seconds(60), assignees: ["bob"] },
      { timeout: seconds(60), channel: ChanOne },
      { timeout: seconds(60), isExpiry: true },
      { timeout: seconds(60), target: Beta },
    ])
      expect(await planned(ask)).toBeDefined();
  });
});

describe("#1307d: the change the store is given", () => {
  it("an operator's deadline is `timeout`, counts as an extension, and carries the reminder the target's remindBefore asks", async () => {
    const plan = await planned({ assignees: ["bob"], timeout: seconds(60) });

    expect(plan.deadline).toEqual({
      expiresAt: new Date(NOW.getTime() + 60_000),
      expiryBound: "pause",
    });
    expect(plan.change).toMatchObject({
      assignees: ["bob"],
      timeout: plan.deadline,
      countsAsExtension: true,
    });
    expect(plan.change).not.toHaveProperty("due");
  });

  it("an expiry's deadline is `due`, always — none gives an empty one — and counts as no extension", async () => {
    const withSpan = await planned({ isExpiry: true, timeout: seconds(60) });
    const withOwn = await planned({ isExpiry: true });
    const unbounded = await planned(
      { isExpiry: true },
      { ...PAUSE, expiresAt: undefined },
      alpha({ timeout: undefined }),
      [alpha({ timeout: undefined })],
    );

    expect(withSpan.change).toMatchObject({ due: withSpan.deadline });
    expect(withSpan.change).not.toHaveProperty("countsAsExtension");
    expect(withSpan.change).not.toHaveProperty("timeout");
    expect(withOwn.change).toHaveProperty("due");
    expect(unbounded.change).toMatchObject({ due: {} });
  });

  it("a move that sets no deadline of its own has the destination's, and carries none when the destination has none", async () => {
    const moved = await planned({ target: Beta }, PAUSE, alpha(), [
      alpha(),
      beta({ timeout: hours(2) }),
    ]);
    const unbounded = await planned({ target: Beta }, PAUSE, alpha(), [
      alpha(),
      beta({ timeout: undefined }),
    ]);

    expect(moved.deadline).toMatchObject({ expiresAt: new Date(NOW.getTime() + 2 * 3_600_000) });
    expect(moved.change).toMatchObject({ timeout: moved.deadline });
    expect(unbounded.deadline).toEqual({});
    expect(unbounded.change).toMatchObject({ timeout: {} });
  });

  it("a replacement and an in-place change carry only what they are given: no assignees, actor or reason when there are none", async () => {
    const bare = await planned({}, { ...PAUSE, assignees: undefined });

    expect(Object.keys(bare.change).sort()).toEqual(["seen"]);
  });
});

describe("#1307d: a destination nobody serves, and a source nobody declared", () => {
  it("an owner's target with no channel takes the pause with no channel in its change", async () => {
    const owner = beta({ channels: new Map() });

    const plan = await planned({ target: Beta }, PAUSE, alpha(), [alpha(), owner]);

    expect(plan.channel).toBeUndefined();
    expect(plan.change).toMatchObject({ to: { target: "beta-tool-approval" } });
    expect((plan.change as { to: object }).to).not.toHaveProperty("channel");
  });

  it("a source whose class is declared as no pause target can hand its pauses to none, the refusal the kind's", async () => {
    const from = alpha({ cls: Plain });

    const error = await refused(planned({ target: Beta }, PAUSE, from));

    expect(error).toBeInstanceOf(PauseError.IncompatibleTarget);
    expect(error.message).toBe(`pause ${KEY}: the target is of another kind or takes other DTOs`);
  });
});

describe("#1307: a count limit", () => {
  it("is reached when the count equals or passes it, never when there is no limit", () => {
    expect(isReached(0, undefined)).toBe(false);
    expect(isReached(1_000_000, undefined)).toBe(false);
    expect(isReached(2, 3)).toBe(false);
    expect(isReached(3, 3)).toBe(true);
    expect(isReached(4, 3)).toBe(true);
    expect(isReached(0, 0)).toBe(true);
  });
});
