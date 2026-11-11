/**
 * #860 (mutation shard `a2a-direct`): a resend while its message's attempt is in flight waits for it
 * — the store read every 250 ms on the `Clock` — and gets its reply; it stops at the caller's
 * disconnect, takes the attempt over at its `expiresAt` exactly, runs the skill itself when the
 * attempt failed, and waits for the attempt another call took over meanwhile.
 */
import { describe, expect, it, vi } from "vitest";
import { directReply } from "../../../src/a2a/server/a2a-direct-reply.js";
import { requestHashOf } from "../../../src/a2a/server/a2a-message-input.js";
import { seconds } from "../../../src/units/index.js";
import { callerOf, messageOf, NINE, refusalOf, settle } from "../server/support/unit-parts.js";
import {
  acceptedMessage,
  DIRECT_SKILL,
  directRig,
  finished,
  gate,
  KEY,
  watched,
  type DirectRig,
} from "./support/direct-parts.js";

const hello = () => messageOf("m-1", ["hello"]);
const helloHash = requestHashOf(DIRECT_SKILL.id, hello());
const REPLY = { finish: "unit-workflow-finish", output: { total: 9 }, spentUsd: 0 };

/** The rig with its first run held at a gate. */
function heldRig(): DirectRig & { readonly release: () => void } {
  const rig = directRig();
  const held = gate();
  rig.script = async () => {
    await held.opened;
    return finished();
  };
  return Object.assign(rig, { release: held.open });
}

const pollFor = async (rig: DirectRig, times: number) => {
  for (let poll = 0; poll < times; poll += 1) await rig.clock.advance(seconds(0.25));
};

describe("#860: a resend while the attempt is in flight", () => {
  it("waits through many polls and gets the reply at the poll after it is kept; the skill runs once", async () => {
    const rig = heldRig();
    const first = directReply(rig.parts, callerOf(), hello(), DIRECT_SKILL);
    await settle();
    const resend = directReply(rig.parts, callerOf(), hello(), DIRECT_SKILL);
    const waiting = watched(resend);

    await pollFor(rig, 8);
    const stillWaiting = !waiting.settled();
    rig.release();
    await first;
    await pollFor(rig, 1);

    expect([stillWaiting, waiting.settled()]).toEqual([true, true]);
    expect(await resend).toEqual(await first);
    expect(rig.runs).toHaveLength(1);
  });

  it("stops when its caller disconnects: the abort, no run of its own", async () => {
    const rig = heldRig();
    void directReply(rig.parts, callerOf(), hello(), DIRECT_SKILL).catch(() => undefined);
    await settle();
    const disconnect = new AbortController();

    const resend = directReply(
      rig.parts,
      callerOf({ signal: disconnect.signal }),
      hello(),
      DIRECT_SKILL,
    );
    await settle();
    disconnect.abort(new Error("gone"));

    expect(await refusalOf(resend)).toBe("Error: gone");
    expect(rig.runs).toHaveLength(1);
  });

  it("takes an attempt over at its expiresAt exactly, not a poll later", async () => {
    const rig = directRig();
    const expiresAt = new Date(NINE.getTime() + seconds(1));
    await rig.messages.saveIfAbsent(
      acceptedMessage({ requestHash: helloHash, expiresAt, callsModel: false }),
    );

    const resend = directReply(rig.parts, callerOf(), hello(), DIRECT_SKILL);
    await pollFor(rig, 4);

    expect(rig.runs).toHaveLength(1);
    expect((await resend).messageId).toBe("attempt-1:reply");
    expect((await rig.messages.findByKey(KEY))?.startedAt).toEqual(expiresAt);
  });

  it("whose attempt fails runs the skill itself under a new attempt", async () => {
    const rig = directRig();
    const held = gate();
    rig.script = async () => {
      await held.opened;
      throw new Error("the model failed");
    };
    const first = directReply(rig.parts, callerOf(), hello(), DIRECT_SKILL);
    await settle();
    const resend = directReply(rig.parts, callerOf(), hello(), DIRECT_SKILL);
    await settle();

    rig.script = () => Promise.resolve(finished());
    held.open();
    const failure = await refusalOf(first);
    await pollFor(rig, 1);

    expect(failure).toBe("Error: the model failed");
    expect((await resend).messageId).toBe("attempt-2:reply");
    expect(rig.runs).toHaveLength(2);
  });

  it("of a lost attempt another call took over first waits for that call's reply, its own attempt's files dropped", async () => {
    const rig = directRig();
    await rig.messages.saveIfAbsent(acceptedMessage({ requestHash: helloHash, expiresAt: NINE }));
    const retake = rig.messages.retakeIfExpired.bind(rig.messages);
    const other = {
      attemptId: "run-other",
      startedAt: NINE,
      expiresAt: new Date(NINE.getTime() + seconds(30)),
    };
    vi.spyOn(rig.messages, "retakeIfExpired").mockImplementationOnce(
      async (key, lostId, attempt, now) => {
        await retake(key, lostId, other, now);
        return retake(key, lostId, attempt, now);
      },
    );
    const dropped = vi.spyOn(rig.parts.files.store, "deleteByOwner");

    const resend = directReply(rig.parts, callerOf(), hello(), DIRECT_SKILL);
    await settle();
    await rig.messages.completeIfInFlight(KEY, "run-other", REPLY, NINE);
    await pollFor(rig, 1);

    expect((await resend).messageId).toBe("run-other:reply");
    expect(dropped.mock.calls).toEqual([[{ tenantId: "acme", ownerId: "attempt-1" }]]);
    expect(rig.runs).toHaveLength(0);
  });
});
