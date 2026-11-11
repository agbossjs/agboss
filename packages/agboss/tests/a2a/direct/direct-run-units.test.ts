/**
 * #860 (mutation shard `a2a-direct`): one attempt's run — the skill's start under the attempt's
 * reserved id, never recovered, on the message's thread with exactly the caller's options and the
 * deadline min(maxTaskDuration, 25 s); aborted at the caller's disconnect and once 25 s pass (then
 * `-32603`, its row and files removed), its bound over with it.
 */
import { describe, expect, it, vi } from "vitest";
import { directReply } from "../../../src/a2a/server/a2a-direct-reply.js";
import { reservedExecutionIdOf, withoutRecoveryOf } from "../../../src/app/tree-control.js";
import { seconds } from "../../../src/units/index.js";
import { callerOf, messageOf, refusalOf, settle } from "../server/support/unit-parts.js";
import { DIRECT_SKILL, directRig, KEY, watched, type RecordedRun } from "./support/direct-parts.js";

const hello = () => messageOf("m-1", ["hello"], { contextId: "ctx-7" });

/** A run that ends only when its signal aborts, rejecting with the abort's reason. */
const untilAborted = (run: RecordedRun) =>
  new Promise<never>((_resolve, reject) => {
    run.options.signal.addEventListener("abort", () => {
      reject(run.options.signal.reason as Error);
    });
  });

describe("#860: an attempt's run", () => {
  it("runs the skill's start on its input under the attempt's id, never recovered, with exactly the caller's options", async () => {
    const rig = directRig();
    const resolved = { ownerId: "dana", tenant: { tenantId: "acme" } };
    Reflect.set(resolved, "execution", { userId: "u-1" });

    await directReply(rig.parts, callerOf({ caller: resolved }), hello(), DIRECT_SKILL);

    const [run] = rig.runs;
    expect(run?.input).toEqual({ text: "hello" });
    expect(Object.keys(run?.options ?? {}).sort()).toEqual(
      ["deadline", "execution", "ownerId", "signal", "tenant", "threadId"].sort(),
    );
    expect(run?.options).toMatchObject({
      threadId: "ctx-7",
      tenant: { tenantId: "acme" },
      ownerId: "dana",
      execution: { userId: "u-1" },
      deadline: seconds(25),
    });
    expect(reservedExecutionIdOf(run?.options ?? {})).toBe("attempt-1");
    expect(withoutRecoveryOf(run?.options ?? {})).toEqual({ callsModel: true });
  });

  it("#860 D1: a skill that calls no model says so to the run no recovery continues", async () => {
    const rig = directRig();

    await directReply(rig.parts, callerOf(), hello(), { ...DIRECT_SKILL, callsModel: false });

    expect(withoutRecoveryOf(rig.runs[0]?.options ?? {})).toEqual({ callsModel: false });
  });

  it("of a caller with nothing but itself: no tenant, owner or values", async () => {
    const rig = directRig();

    await directReply(
      rig.parts,
      callerOf({ caller: {}, ownerId: undefined }),
      hello(),
      DIRECT_SKILL,
    );

    expect(Object.keys(rig.runs[0]?.options ?? {}).sort()).toEqual(
      ["deadline", "signal", "threadId"].sort(),
    );
  });

  it("has the listener's maxTaskDuration as its deadline, within 25 s", async () => {
    const deadlineWith = async (maxTaskDuration: number) => {
      const rig = directRig({ maxTaskDuration: maxTaskDuration as never });
      await directReply(rig.parts, callerOf(), hello(), DIRECT_SKILL);
      return rig.runs[0]?.options.deadline;
    };

    expect([await deadlineWith(seconds(10)), await deadlineWith(seconds(60))]).toEqual([
      seconds(10),
      seconds(25),
    ]);
  });

  it("is aborted once 25 s pass: -32603, its row and its files removed", async () => {
    const rig = directRig();
    rig.script = untilAborted;
    const dropped = vi.spyOn(rig.parts.files.store, "deleteByOwner");
    const answer = directReply(rig.parts, callerOf(), hello(), DIRECT_SKILL);
    const answered = watched(answer);
    await settle();

    await rig.clock.advance(seconds(24));
    const before = answered.settled();
    await rig.clock.advance(seconds(1));

    expect([before, answered.settled()]).toEqual([false, true]);
    expect(await refusalOf(answer)).toBe("A2AInternalError: the request failed");
    expect(await rig.messages.findByKey(KEY)).toBeUndefined();
    expect(dropped.mock.calls).toEqual([[{ tenantId: "acme", ownerId: "attempt-1" }]]);
  });

  it("is aborted when its caller disconnects", async () => {
    const rig = directRig();
    rig.script = untilAborted;
    const disconnect = new AbortController();
    const answer = directReply(
      rig.parts,
      callerOf({ signal: disconnect.signal }),
      hello(),
      DIRECT_SKILL,
    );
    await settle();

    disconnect.abort(new Error("gone"));

    expect(await refusalOf(answer)).toBe("Error: gone");
  });

  it("that finished ends its bound with it: its signal never aborted after", async () => {
    const rig = directRig();
    await directReply(rig.parts, callerOf(), hello(), DIRECT_SKILL);

    await rig.clock.advance(seconds(30));

    expect(rig.runs[0]?.options.signal.aborted).toBe(false);
  });
});
