/**
 * #1307c, #1356 (shard `pauses`) — the permission hooks of a pause's target on their own (`answer-permit.ts`): which
 * target a pause asks, what each hook is told (exactly, each optional part only when there), how an unresolvable
 * target, a throw, a rejection and any value but `true` refuse — with the message that names the pause and never the hook's
 * text — and when an operator act is refused because the target guards answers but not that act.
 */
import { describe, expect, it, vi } from "vitest";
import {
  assertAnswerPermitted,
  assertDeadlineNotGuarded,
  assertNotAnswerGuarded,
  assertReassignPermitted,
  assertTimeoutChangePermitted,
  permitsOf,
  reassignPermitsOf,
  targetOfPause,
} from "../../src/app/answer-permit.js";
import { PauseError } from "../../src/core/error-families/pause-errors.js";
import { pauseKeyOf, type PauseRecord } from "../../src/infrastructure/pause-record.js";
import { pauseOf } from "../../src/testing/contracts/paused-execution-data.js";
import { seconds } from "../../src/units/index.js";

const PAUSE: PauseRecord = {
  ...pauseOf("p-1"),
  assignees: ["ann"],
  externalRef: "TICKET-1",
  expiresAt: new Date("2026-01-05T12:00:00.000Z"),
};
const BARE: PauseRecord = {
  ...pauseOf("p-2"),
  toolCall: undefined,
  channel: undefined,
  expiresAt: undefined,
};
const KEY = pauseKeyOf(PAUSE.tenantId, PAUSE.pauseId);
const ACTOR = { id: "manager-17", orgId: "hq" };

/** The deps of the pause's workflow, whose target of the pause's name is `target`. */
const depsOf = (target: unknown, workflow = PAUSE.workflow) =>
  ({
    config: { name: workflow },
    graph: { nodes: new Map() },
    targetOf: (name: string) => {
      if (name !== PAUSE.target) throw new Error(`Unknown pause target: ${name}`);
      return target;
    },
  }) as never;

const thrownBy = async (run: () => unknown): Promise<unknown> => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  return undefined;
};

const denied = (message: string, cause?: unknown) => ({
  isDenied: true,
  message,
  cause,
});
const deniedOf = (error: unknown) => ({
  isDenied: error instanceof PauseError.PermissionDenied,
  message: (error as Error).message,
  cause: (error as Error).cause,
});

describe("#1307c: the target a pause asks", () => {
  it("is its workflow's target of the pause's name; none of a workflow without targets is a TypeError naming it", () => {
    const target = { permitAnswer: () => Promise.resolve(true) };

    expect(targetOfPause(depsOf(target), PAUSE)).toBe(target);
    expect(permitsOf(depsOf(target))(PAUSE)).toBe(target.permitAnswer);
    expect(() =>
      targetOfPause(
        { config: { name: PAUSE.workflow }, graph: { nodes: new Map() } } as never,
        PAUSE,
      ),
    ).toThrow(new TypeError("no pause target refund-tool-approval"));
    expect(() => targetOfPause(depsOf(undefined), PAUSE)).toThrow(
      new TypeError("no pause target refund-tool-approval"),
    );
    expect(() => targetOfPause(depsOf(target), { ...PAUSE, target: "gone" })).toThrow(
      "Unknown pause target: gone",
    );
  });
});

describe("#1307c: an answer's permission", () => {
  const permits = (hook: unknown) => ({ permits: () => hook }) as never;

  it("is told the pause and the answer — the actor, assignees, tool call and external reference only when there, the trail as copies", async () => {
    const hook = vi.fn((_call: unknown) => Promise.resolve(true));

    await assertAnswerPermitted(permits(hook), PAUSE, ACTOR, { approved: true });
    await assertAnswerPermitted(permits(hook), BARE, undefined, "no");

    expect(hook.mock.calls[0]?.[0]).toStrictEqual({
      actor: ACTOR,
      assignees: ["ann"],
      input: PAUSE.input,
      output: { approved: true },
      toolCall: PAUSE.toolCall,
      externalRef: "TICKET-1",
      trail: PAUSE.trail,
    });
    expect((hook.mock.calls[0]?.[0] as { trail: unknown[] }).trail[0]).not.toBe(PAUSE.trail[0]);
    expect(hook.mock.calls[1]?.[0]).toStrictEqual({
      input: BARE.input,
      output: "no",
      trail: BARE.trail,
    });
  });

  it("is given by a target with no hook, and by a hook that says exactly `true`", async () => {
    await expect(
      assertAnswerPermitted(permits(undefined), PAUSE, ACTOR, 1),
    ).resolves.toBeUndefined();
    await expect(
      assertAnswerPermitted(
        permits(() => Promise.resolve(true)),
        PAUSE,
        ACTOR,
        1,
      ),
    ).resolves.toBeUndefined();
  });

  it.each([false, "true", 1, undefined, null, {}])(
    "is refused by a hook that says %j, naming the pause and the hook",
    async (verdict) => {
      const error = await thrownBy(() =>
        assertAnswerPermitted(
          permits(() => Promise.resolve(verdict)),
          PAUSE,
          ACTOR,
          1,
        ),
      );

      expect(deniedOf(error)).toEqual(
        denied(`pause ${KEY}: its target's permitAnswer refused the answer`),
      );
    },
  );

  it("is refused by a hook that throws or rejects, the failure its cause and its text never the message's", async () => {
    const failure = new Error("secret text");

    const rejected = await thrownBy(() =>
      assertAnswerPermitted(
        permits(() => Promise.reject(failure)),
        PAUSE,
        ACTOR,
        1,
      ),
    );
    const thrown = await thrownBy(() =>
      assertAnswerPermitted(
        permits(() => {
          throw failure;
        }),
        PAUSE,
        ACTOR,
        1,
      ),
    );

    for (const error of [rejected, thrown])
      expect(deniedOf(error)).toEqual(
        denied(`pause ${KEY}: its target's permitAnswer failed, the answer is refused`, failure),
      );
  });

  it("is refused when the target cannot be resolved: whether it has the hook is unknown", async () => {
    const failure = new Error("container");
    const error = await thrownBy(() =>
      assertAnswerPermitted(
        {
          permits: () => {
            throw failure;
          },
        },
        PAUSE,
        ACTOR,
        1,
      ),
    );

    expect(deniedOf(error)).toEqual(
      denied(`pause ${KEY}: its target cannot be resolved, the answer is refused`, failure),
    );
  });

  it("is given when the application has no permits at all", async () => {
    await expect(assertAnswerPermitted({}, PAUSE, ACTOR, 1)).resolves.toBeUndefined();
  });
});

describe("#1307d: a reassignment's permission", () => {
  const ask = {
    actor: ACTOR,
    assignees: ["bob"],
    reason: "on leave",
    toTarget: class ToTarget {
      readonly mark = "t";
    },
    toChannel: class ToChannel {
      readonly mark = "c";
    },
    timeout: seconds(60),
  };

  it("is told where to, why and how long, besides what the pause has — each part only when there", async () => {
    const hook = vi.fn((_call: unknown) => Promise.resolve(true));
    const target = { permitReassign: hook };

    await assertReassignPermitted(depsOf(target), PAUSE, ask);
    await assertReassignPermitted(depsOf(target), BARE, {});

    expect(hook.mock.calls[0]?.[0]).toStrictEqual({
      actor: ACTOR,
      assignees: ["ann"],
      channel: PAUSE.channel,
      toAssignees: ["bob"],
      toTarget: ask.toTarget,
      toChannel: ask.toChannel,
      timeout: seconds(60),
      reason: "on leave",
      toolCall: PAUSE.toolCall,
      externalRef: "TICKET-1",
      input: PAUSE.input,
      target: PAUSE.target,
      trail: PAUSE.trail,
    });
    expect(hook.mock.calls[1]?.[0]).toStrictEqual({
      input: BARE.input,
      target: BARE.target,
      trail: BARE.trail,
    });
  });

  it("asks the target the caller names, never the workflow's, and is not refused for guarding answers then", async () => {
    const hook = vi.fn((_call: unknown) => Promise.resolve(true));
    const guarded = { permitAnswer: () => Promise.resolve(true) };

    await assertReassignPermitted(depsOf(guarded), PAUSE, ask, { permitReassign: hook } as never);

    expect(hook).toHaveBeenCalledOnce();
    expect(reassignPermitsOf(depsOf(guarded))(PAUSE)).toBeUndefined();
  });

  it("is refused for a target that guards answers but has no permitReassign, naming the pause and the act", async () => {
    const target = { permitAnswer: () => Promise.resolve(true) };

    const error = await thrownBy(() => assertReassignPermitted(depsOf(target), PAUSE, ask));

    expect(deniedOf(error)).toEqual(
      denied(
        `pause ${KEY}: its target guards answers with permitAnswer but has no permitReassign, so a reassignment is refused`,
      ),
    );
  });

  it.each([false, undefined])("is refused by a permitReassign that says %j", async (verdict) => {
    const error = await thrownBy(() =>
      assertReassignPermitted(
        depsOf({ permitReassign: () => Promise.resolve(verdict) }),
        PAUSE,
        ask,
      ),
    );

    expect(deniedOf(error)).toEqual(
      denied(`pause ${KEY}: its target's permitReassign refused the reassignment`),
    );
  });

  it("is refused when the target cannot be resolved, naming the act", async () => {
    const error = await thrownBy(() =>
      assertReassignPermitted(depsOf({}), { ...PAUSE, target: "gone" }, ask),
    );

    expect(deniedOf(error)).toEqual(
      denied(
        `pause ${KEY}: its target cannot be resolved, the reassignment is refused`,
        (error as Error).cause,
      ),
    );
    expect((error as Error).cause).toHaveProperty("message", "Unknown pause target: gone");
  });
});

describe("#1307, H2: an act of an operator on a pause whose target guards its answers", () => {
  const guarded = { permitAnswer: () => Promise.resolve(true) };

  it.each(["permitTimeoutChange", "permitReassign"] as const)(
    "is let through when the target declares %s, or guards no answer, or cannot be resolved",
    (hook) => {
      expect(() => {
        assertNotAnswerGuarded(
          depsOf({ ...guarded, [hook]: () => Promise.resolve(true) }),
          PAUSE,
          hook,
          "x",
        );
      }).not.toThrow();
      expect(() => {
        assertNotAnswerGuarded(depsOf({}), PAUSE, hook, "x");
      }).not.toThrow();
      expect(() => {
        assertNotAnswerGuarded(depsOf(guarded), { ...PAUSE, target: "gone" }, hook, "x");
      }).not.toThrow();
    },
  );

  it.each(["permitTimeoutChange", "permitReassign"] as const)(
    "is refused without %s, the message naming the pause, the hook and the act",
    (hook) => {
      let error: unknown;
      try {
        assertNotAnswerGuarded(depsOf(guarded), PAUSE, hook, "the act");
      } catch (caught) {
        error = caught;
      }

      expect(deniedOf(error)).toEqual(
        denied(
          `pause ${KEY}: its target guards answers with permitAnswer but has no ${hook}, so the act is refused`,
        ),
      );
    },
  );

  const guardedBy = (current: Date | undefined, next: Date | undefined): boolean => {
    try {
      assertDeadlineNotGuarded(depsOf(guarded), { ...PAUSE, expiresAt: current }, next);
      return false;
    } catch (error) {
      expect(deniedOf(error).message).toBe(
        `pause ${KEY}: its target guards answers with permitAnswer but has no permitTimeoutChange, so a change that is not a longer deadline is refused`,
      );
      return true;
    }
  };

  it("is guarded for a deadline that shortens: an earlier one, none where there was one, one where there was none; the same or a longer one, or none for none, passes", () => {
    const at = new Date("2026-01-05T12:00:00.000Z");
    const earlier = new Date("2026-01-05T11:00:00.000Z");
    const later = new Date("2026-01-05T13:00:00.000Z");

    expect(guardedBy(at, earlier)).toBe(true);
    expect(guardedBy(at, undefined)).toBe(true);
    expect(guardedBy(undefined, at)).toBe(true);
    expect(guardedBy(at, new Date(at))).toBe(false);
    expect(guardedBy(at, later)).toBe(false);
    expect(guardedBy(undefined, undefined)).toBe(false);
  });
});

describe("#1307: a timeout change's permission", () => {
  it("is told how long, why and the pause's deadline now as a copy, each part only when there", async () => {
    const hook = vi.fn((_call: unknown) => Promise.resolve(true));
    const target = { permitTimeoutChange: hook };

    await assertTimeoutChangePermitted(depsOf(target), PAUSE, {
      actor: ACTOR,
      timeout: seconds(90),
      reason: "needs more time",
    });
    await assertTimeoutChangePermitted(depsOf(target), BARE, { timeout: seconds(5) });

    expect(hook.mock.calls[0]?.[0]).toStrictEqual({
      actor: ACTOR,
      assignees: ["ann"],
      currentExpiresAt: PAUSE.expiresAt,
      reason: "needs more time",
      toolCall: PAUSE.toolCall,
      externalRef: "TICKET-1",
      input: PAUSE.input,
      timeout: seconds(90),
      trail: PAUSE.trail,
    });
    expect((hook.mock.calls[0]?.[0] as { currentExpiresAt: Date }).currentExpiresAt).not.toBe(
      PAUSE.expiresAt,
    );
    expect(hook.mock.calls[1]?.[0]).toStrictEqual({
      input: BARE.input,
      timeout: seconds(5),
      trail: BARE.trail,
    });
  });

  it("is given by a target with no hook, refused by one that says no, or whose target is gone — naming the act", async () => {
    await expect(
      assertTimeoutChangePermitted(depsOf({}), PAUSE, { timeout: seconds(5) }),
    ).resolves.toBeUndefined();
    const no = await thrownBy(() =>
      assertTimeoutChangePermitted(
        depsOf({ permitTimeoutChange: () => Promise.resolve(false) }),
        PAUSE,
        {
          timeout: seconds(5),
        },
      ),
    );
    const gone = await thrownBy(() =>
      assertTimeoutChangePermitted(
        depsOf({}),
        { ...PAUSE, target: "gone" },
        { timeout: seconds(5) },
      ),
    );

    expect(deniedOf(no).message).toBe(
      `pause ${KEY}: its target's permitTimeoutChange refused the timeout change`,
    );
    expect(deniedOf(gone).message).toBe(
      `pause ${KEY}: its target cannot be resolved, the timeout change is refused`,
    );
  });
});
