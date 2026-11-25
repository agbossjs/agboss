/**
 * #1307c: fail closed. A pause whose target cannot be resolved (a renamed or removed workflow or
 * channel, a container error) is refused: whether it has a `permitAnswer` is unknown. Only a target
 * known to have none answers unchecked.
 */
import { pauseKeyOf } from "../../src/infrastructure/pause-record.js";
import { describe, expect, it } from "vitest";
import { assertAnswerPermitted, permitsOf } from "../../src/app/answer-permit.js";
import type { AppDeps } from "../../src/app/app-deps.js";
import type { PauseRecord } from "../../src/infrastructure/pause-record.js";
import { PauseError } from "../../src/index.js";

const pause = {
  pauseId: "p-1",
  tenantId: "default",
  workflow: "gone-workflow",
  target: "gone-target",
  channel: "gone-channel",
} as PauseRecord;

const depsOf = (targetOf: unknown): AppDeps =>
  ({ config: { name: "gone-workflow" }, targetOf }) as never;

describe("#1307c: an unresolvable target refuses the answer", () => {
  it("a channel the workflow no longer has", async () => {
    const parts = {
      permits: permitsOf(
        depsOf(() => {
          throw new Error("Unknown pause target: gone-target");
        }),
      ),
    };
    const refused = await assertAnswerPermitted(parts, pause, { id: "dana" }, {}).catch(
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(PauseError.PermissionDenied);
    expect((refused as Error).message).toBe(
      `pause ${pauseKeyOf("default", "p-1")}: its target cannot be resolved, the answer is refused`,
    );
    expect((refused as Error).cause).toMatchObject({
      message: "Unknown pause target: gone-target",
    });
  });

  it("a workflow with no channels at all", async () => {
    const parts = { permits: permitsOf(depsOf(undefined)) };
    await expect(assertAnswerPermitted(parts, pause, { id: "dana" }, {})).rejects.toBeInstanceOf(
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
      permits: permitsOf(
        depsOf(() => ({ name: "gone-target", respondent: "delegate", channels: new Map() })),
      ),
    };
    await expect(assertAnswerPermitted(parts, pause, { id: "dana" }, {})).resolves.toBeUndefined();
  });
});
