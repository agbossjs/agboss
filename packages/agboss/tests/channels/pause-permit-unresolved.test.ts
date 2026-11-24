/**
 * #1307c: fail closed. A pause whose target cannot be resolved (a renamed or removed workflow or
 * channel, a container error) is refused: whether it has a `permitAnswer` is unknown. Only a target
 * known to have none answers unchecked.
 */
import { describe, expect, it } from "vitest";
import { assertAnswerPermitted, permitsOf } from "../../src/app/answer-permit.js";
import type { AppDeps } from "../../src/app/app-deps.js";
import type { PauseRecord } from "../../src/infrastructure/pause-record.js";
import { PauseError } from "../../src/index.js";

const pause = { pauseId: "p-1", workflow: "gone-workflow", channel: "gone-channel" } as PauseRecord;

const depsOf = (channelOf: unknown): AppDeps =>
  ({ config: { name: "gone-workflow" }, channelOf }) as never;

describe("#1307c: an unresolvable target refuses the answer", () => {
  it("a channel the workflow no longer has", async () => {
    const parts = {
      permits: permitsOf(
        depsOf(() => {
          throw new Error("Unknown channel: gone-channel");
        }),
      ),
    };
    const refused = await assertAnswerPermitted(parts, pause, "dana", {}).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(PauseError.PermissionDenied);
    expect((refused as Error).message).toBe(
      "pause p-1: its target cannot be resolved, the answer is refused",
    );
    expect((refused as Error).cause).toMatchObject({ message: "Unknown channel: gone-channel" });
  });

  it("a workflow with no channels at all", async () => {
    const parts = { permits: permitsOf(depsOf(undefined)) };
    await expect(assertAnswerPermitted(parts, pause, "dana", {})).rejects.toBeInstanceOf(
      PauseError.PermissionDenied,
    );
  });

  it("a resolver that fails", async () => {
    const parts = {
      permits: () => {
        throw new Error("container");
      },
    };
    await expect(assertAnswerPermitted(parts, pause, undefined, {})).rejects.toBeInstanceOf(
      PauseError.PermissionDenied,
    );
  });

  it("a target known to have no permitAnswer still answers", async () => {
    const parts = {
      permits: permitsOf(depsOf(() => ({ name: "gone-channel", answerer: "channel" }))),
    };
    await expect(assertAnswerPermitted(parts, pause, "dana", {})).resolves.toBeUndefined();
  });
});
