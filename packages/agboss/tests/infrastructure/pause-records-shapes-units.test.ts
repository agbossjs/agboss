/**
 * #1307, #946, #1356 (shard `pauses`) — what the records of a pause are made of, on their own: the pause as JSON stored
 * it (each optional part only when written, the answer's marker, usage and actor, what is refused and how), the
 * entry of the log a resolved pause leaves, the replacement a reassignment makes and the chain entry and
 * bound of a timeout change — whole values, the optional parts of each only when there.
 */
import { describe, expect, it, vi } from "vitest";
import { StoreError } from "../../src/core/error-families/store-errors.js";
import { PauseNoticeKind } from "../../src/infrastructure/pause-notices.js";
import { logPauseAnswer } from "../../src/infrastructure/pause-answer-log.js";
import { replacementPause } from "../../src/infrastructure/pause-replacement.js";
import { timeoutChange } from "../../src/infrastructure/pause-timeout-change.js";
import {
  PauseExpiryBound,
  PauseKind,
  PauseResolution,
  PauseStatus,
  replyAskOf,
  type PauseRecord,
} from "../../src/infrastructure/pause-record.js";
import { pauseRecordOfJson } from "../../src/infrastructure/stored-pause.js";
import { pauseOf, RECIPIENTS } from "../../src/testing/contracts/paused-execution-data.js";

const AT = new Date("2026-01-05T10:00:00.000Z");
const LATER = new Date("2026-01-05T12:00:00.000Z");
const json = (record: unknown): unknown => JSON.parse(JSON.stringify(record));

/** A question: no tool call, none of the optional parts. */
const BARE: PauseRecord = (() => {
  const { toolCall: _t, channel: _c, ...rest } = pauseOf("p-q");
  return { ...rest, kind: PauseKind.ExternalTask };
})();
const FULL: PauseRecord = {
  ...pauseOf("p-f"),
  assignees: ["ann"],
  externalRef: "TICKET-1",
  branchKeys: ["b-1"],
  expiresAt: LATER,
};
const caught = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("#934: a pause read from the JSON a store kept", () => {
  it("has the channel, tool call, assignees, reference and branch keys only when they were written", () => {
    const bare = pauseRecordOfJson(json(BARE));
    const full = pauseRecordOfJson(json(FULL));

    for (const key of ["channel", "toolCall", "assignees", "externalRef", "branchKeys"])
      expect(bare).not.toHaveProperty(key);
    expect(full).toMatchObject({
      channel: FULL.channel,
      toolCall: FULL.toolCall,
      assignees: ["ann"],
      externalRef: "TICKET-1",
      branchKeys: ["b-1"],
    });
    expect(full.askedAt).toEqual(FULL.askedAt);
  });

  it("refuses an approval with no tool call and a question with one, naming the tool call", () => {
    const approval = { ...(json(FULL) as object), toolCall: undefined };
    const question = { ...(json(BARE) as object), toolCall: { callId: "c", tool: "t" } };

    for (const stored of [approval, question]) {
      const error = caught(() => pauseRecordOfJson(stored));
      expect(error).toBeInstanceOf(StoreError.UnreadableRecord);
      expect((error as Error).message).toMatch(
        /^a stored pause is not readable \(pause [0-9a-f]{32}, executionId run-1\): the field\(s\) toolCall missing or not what the framework wrote$/,
      );
    }
  });

  it("names the pause by its ids in what it refuses, and the field, never a value", () => {
    const error = caught(() => pauseRecordOfJson({ ...(json(FULL) as object), status: "bogus" }));

    expect(error).toBeInstanceOf(StoreError.UnreadableRecord);
    expect((error as Error).message).toMatch(
      /^a stored pause is not readable \(pause [0-9a-f]{32}, executionId run-1\): the field\(s\) status missing or not what the framework wrote$/,
    );
  });

  it("keeps the answer's marker of a delegate's decision only when true, and the usage as it was written", () => {
    const usage = {
      caller: "agent",
      model: "m",
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 3,
      cacheWriteTokens: 4,
      costUsd: 0.5,
      costSource: "api",
      provider: "p",
      extra: "kept",
    };
    const answered = (answer: object) =>
      pauseRecordOfJson({ ...(json(FULL) as object), answer: { decision: { ok: 1 }, ...answer } })
        .answer;

    expect(answered({ byDelegate: true })).toStrictEqual({
      decision: { ok: 1 },
      actor: undefined,
      byDelegate: true,
    });
    expect(answered({ byDelegate: false })).toStrictEqual({
      decision: { ok: 1 },
      actor: undefined,
    });
    expect(answered({})).toStrictEqual({ decision: { ok: 1 }, actor: undefined });
    expect(answered({ usage: [usage] })?.usage).toHaveLength(1);
    expect(answered({ usage: [usage] })?.usage?.[0]).toMatchObject({
      extra: "kept",
      inputTokens: 1,
    });
    for (const field of [
      "caller",
      "model",
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "costUsd",
      "costSource",
      "provider",
    ]) {
      const { [field]: _gone, ...broken } = usage as Record<string, unknown>;
      expect(caught(() => answered({ usage: [broken] }))).toBeInstanceOf(
        StoreError.UnreadableRecord,
      );
    }
    expect(answered({ usage: [] })?.usage).toEqual([]);
  });

  it("refuses a tool call that is no `{ callId, tool }`", () => {
    for (const toolCall of [{ callId: "c" }, { tool: "t" }, "charge"])
      expect(
        caught(() => pauseRecordOfJson({ ...(json(FULL) as object), toolCall })),
      ).toBeInstanceOf(StoreError.UnreadableRecord);
    expect(
      pauseRecordOfJson({
        ...(json(FULL) as object),
        toolCall: { callId: "c", tool: "t", summary: "s" },
      }).toolCall,
    ).toEqual({ callId: "c", tool: "t", summary: "s" });
  });
});

describe("#267: what a reply to a pause is asked", () => {
  it("is the tool call with its arguments for an approval, and the input for a question", () => {
    expect(replyAskOf(FULL)).toEqual({ ...FULL.toolCall, arguments: FULL.input });
    expect(replyAskOf(BARE)).toBe(BARE.input);
  });
});

describe("#267: the entry a resolved pause leaves in the log", () => {
  const logged = async (pause: PauseRecord) => {
    const savePauseAnswer = vi.fn(() => Promise.resolve());
    await logPauseAnswer({ savePauseAnswer } as never, pause, PauseResolution.Replied);
    return savePauseAnswer.mock.calls[0] as unknown as [string, string, Record<string, unknown>];
  };

  it("keeps what the pause asked and who had it — the channel, tool call, assignees and reference only when there", async () => {
    const [tenant, root, bare] = await logged(BARE);
    const [, , full] = await logged(FULL);

    expect([tenant, root]).toEqual([BARE.tenantId, BARE.rootExecutionId]);
    for (const key of ["channel", "toolCall", "assignees", "externalRef"])
      expect(bare).not.toHaveProperty(key);
    expect(full).toMatchObject({
      channel: FULL.channel,
      toolCall: FULL.toolCall,
      assignees: ["ann"],
      externalRef: "TICKET-1",
      input: FULL.input,
      target: FULL.target,
    });
  });
});

describe("#946: the pause that takes the place of another", () => {
  const input = (changes: object = {}) =>
    ({ pauseId: "p-new", stepKey: "k~r1", ...changes }) as never;

  it("is pending and unsent with the old pause's question and chain, a `reassigned` entry, and no reference, assignees or channel of the old", () => {
    const next = replacementPause(
      FULL,
      input({ assignees: ["bob"], actor: { id: "ops" }, reason: "leave" }),
      AT,
    );

    expect(next).toMatchObject({
      pauseId: "p-new",
      stepKey: "k~r1",
      status: PauseStatus.Pending,
      isSent: false,
      askedAt: AT,
      reassignedFrom: "p-f",
      assignees: ["bob"],
      expiresAt: FULL.expiresAt,
    });
    expect(next).not.toHaveProperty("externalRef");
    expect(next.trail).toEqual([
      ...FULL.trail,
      {
        action: "reassigned",
        at: AT,
        actor: { id: "ops" },
        target: FULL.target,
        channel: FULL.channel,
        assignees: ["bob"],
        reason: "leave",
        expiresAt: LATER,
      },
    ]);
    expect(next.channel).toBe(FULL.channel);
  });

  it("with nothing of its own adds a bare entry and keeps the old pause's place; the old assignees go", () => {
    const next = replacementPause(FULL, input(), AT);

    expect(next).not.toHaveProperty("assignees");
    expect(next.trail.at(-1)).toEqual({
      action: "reassigned",
      at: AT,
      target: FULL.target,
      channel: FULL.channel,
      expiresAt: LATER,
    });
    const owner = replacementPause({ ...BARE, expiresAt: undefined }, input(), AT);
    expect(owner).not.toHaveProperty("channel");
    expect(owner.trail.at(-1)).toEqual({ action: "reassigned", at: AT, target: BARE.target });
  });

  it("with a destination takes its target, respondent and channel, narrowed by its limits, and its entry names them", () => {
    const next = replacementPause(
      FULL,
      input({
        to: {
          target: "beta-tool-approval",
          respondent: "owner",
          channel: "beta-channel",
          limits: { escalationLimits: { maxReassignments: 1 } },
        },
      }),
      AT,
    );
    const noChannel = replacementPause(
      FULL,
      input({ to: { target: "beta-tool-approval", respondent: "owner" } }),
      AT,
    );

    expect(next).toMatchObject({
      target: "beta-tool-approval",
      respondent: "owner",
      channel: "beta-channel",
      escalationLimits: { maxReassignments: 1 },
    });
    expect(next.trail.at(-1)).toMatchObject({
      target: "beta-tool-approval",
      channel: "beta-channel",
    });
    expect(noChannel).not.toHaveProperty("channel");
    expect(noChannel.trail.at(-1)).not.toHaveProperty("channel");
  });

  it("with a deadline set (an expiry's or a call's) drops the old deadline, its source and reminder, takes the new, and a call's counts as a change too", () => {
    const old: PauseRecord = { ...FULL, expiryBound: PauseExpiryBound.Quorum, remindAt: AT };
    const deadline = { expiresAt: LATER, expiryBound: PauseExpiryBound.Pause };

    const expiry = replacementPause(old, input({ due: deadline }), AT);
    const call = replacementPause(old, input({ timeout: deadline, countsAsExtension: true }), AT);
    const kept = replacementPause(old, input(), AT);

    expect(expiry).toMatchObject({ expiresAt: LATER, expiryBound: PauseExpiryBound.Pause });
    expect(expiry).not.toHaveProperty("remindAt");
    expect(expiry.trail.at(-1)).toMatchObject({ action: "reassigned", expiresAt: LATER });
    expect(call.trail.slice(-2).map((entry) => entry.action)).toEqual([
      "reassigned",
      "timeout-changed",
    ]);
    expect(kept).toMatchObject({
      expiryBound: PauseExpiryBound.Quorum,
      remindAt: AT,
      expiresAt: FULL.expiresAt,
    });
    expect(kept.trail.at(-1)?.action).toBe("reassigned");
    // a deadline set that is none: nothing is kept of the old
    const none = replacementPause(old, input({ due: {} }), AT);
    expect(none).not.toHaveProperty("expiresAt");
    expect(none.trail.at(-1)).not.toHaveProperty("expiresAt");
  });
});

describe("#942: a timeout change's record", () => {
  const seen = {
    trailLength: FULL.trail.length,
    isSent: false,
    assignees: FULL.assignees,
  } as never;
  const pending: PauseRecord = {
    ...FULL,
    expiresAt: LATER,
    boundAt: LATER,
    expiryBound: PauseExpiryBound.Quorum,
  };
  const changed = (pause: PauseRecord, change: object) =>
    timeoutChange(
      pause,
      {
        seen: {
          trailLength: pause.trail.length,
          isSent: pause.isSent,
          ...(pause.assignees === undefined ? {} : { assignees: pause.assignees }),
          ...(pause.expiresAt === undefined ? {} : { expiresAt: pause.expiresAt }),
        },
        previousExpiresAt: pause.expiresAt,
        ...change,
      },
      AT,
      RECIPIENTS,
    );

  it("keeps the source of a deadline set exactly to the bound the pause was made under, and is the pause's own otherwise", () => {
    const exact = changed(pending, { expiresAt: LATER });
    const earlier = changed(pending, { expiresAt: new Date(LATER.getTime() - 1000) });
    const none = changed(pending, {});
    const unsourced = changed({ ...pending, expiryBound: undefined }, { expiresAt: LATER });

    expect(exact?.pause.expiryBound).toBe(PauseExpiryBound.Quorum);
    expect(earlier?.pause.expiryBound).toBe(PauseExpiryBound.Pause);
    expect(none?.pause.expiryBound).toBe(PauseExpiryBound.Pause);
    expect(unsourced?.pause.expiryBound).toBe(PauseExpiryBound.Pause);
  });

  it("adds an entry naming who, where and why — each of the actor, channel, assignees, reference, deadline and reason only when there", () => {
    const full = changed(pending, {
      expiresAt: new Date(LATER.getTime() + 1000),
      actor: { id: "ops" },
      reason: "more time",
    });
    const bare = changed(
      { ...BARE, expiresAt: LATER },
      { expiresAt: new Date(LATER.getTime() + 1000) },
    );
    const taken = changed({ ...BARE, expiresAt: LATER }, {});

    expect(full?.pause.trail.at(-1)).toEqual({
      action: "timeout-changed",
      at: AT,
      actor: { id: "ops" },
      target: pending.target,
      channel: pending.channel,
      assignees: ["ann"],
      expiresAt: new Date(LATER.getTime() + 1000),
      externalRef: "TICKET-1",
      reason: "more time",
    });
    expect(bare?.pause.trail.at(-1)).toEqual({
      action: "timeout-changed",
      at: AT,
      target: BARE.target,
      expiresAt: new Date(LATER.getTime() + 1000),
    });
    expect(taken?.pause.trail.at(-1)).toEqual({
      action: "timeout-changed",
      at: AT,
      target: BARE.target,
    });
  });

  it("tells the change's notice both deadlines, the actor and the reason only when there", () => {
    const full = changed(pending, {
      expiresAt: new Date(LATER.getTime() + 1000),
      actor: { id: "ops" },
      reason: "more",
    });
    const bare = changed({ ...BARE, expiresAt: LATER }, {});

    expect(full?.notices.map((one) => one.notice)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: PauseNoticeKind.TimeoutChanged,
          expiresAt: new Date(LATER.getTime() + 1000),
          previousExpiresAt: LATER,
          actor: { id: "ops" },
          changeReason: "more",
        }),
      ]),
    );
    expect(Object.keys(bare?.notices[0]?.notice ?? {}).sort()).toEqual(
      ["kind", "previousExpiresAt", "seq", "writtenAt"].filter((key) => key !== "seq"),
    );
    seen;
  });
});
