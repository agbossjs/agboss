/**
 * #1366 (cancel-x-pauses shard) — what a pause step names: the error of a pause withdrawn before its answer (its branch
 * cancelled) and of a channel whose `send` broke are told apart by their name, code and text, and an unowned thread's
 * pause is answered by the name stored for it.
 */
import { describe, expect, it } from "vitest";
import { AGBossError } from "../../src/core/errors.js";
import {
  ChannelSendError,
  PauseWithdrawnError,
  THREAD_OWNER,
} from "../../src/flow/runtime/pause.js";

describe("#1366: the errors of a pause step", () => {
  it("a pause withdrawn before its answer is an AGBoss error of its own name and code, with the text it was given", () => {
    const error = new PauseWithdrawnError({ message: "pause p1 was withdrawn" });

    expect(error).toBeInstanceOf(AGBossError);
    expect(error.name).toBe("PauseWithdrawnError");
    expect(PauseWithdrawnError.code).toBe("pause.withdrawn");
    expect(error.message).toBe("pause p1 was withdrawn");
  });

  it("a channel whose send broke is named, says which channel, and keeps the cause", () => {
    const cause = new Error("down");

    const error = new ChannelSendError("email", cause);

    expect(error.name).toBe("ChannelSendError");
    expect(error.message).toBe("channel email: send() failed");
    expect(error.cause).toBe(cause);
  });

  it("an unowned thread's pause is answered by the thread's owner", () => {
    expect(THREAD_OWNER).toBe("the thread's owner");
  });
});
