/**
 * #1318c: the pause shelves of a profile — `toolApprovals` and `externalTasks` by name: how long a pause
 * waits and how long before it the reminder goes. The deadline of the pause, the channel's entry and
 * `describe` all read the same value.
 */
import { describe, expect, it } from "vitest";
import { applicationOf } from "../../src/application/assemble.js";
import { ProfileError, ProfileErrorReason } from "../../src/config/profile-error.js";
import { describedChannelsOf } from "../../src/describe/channels.js";
import { callTool, testWith } from "../../src/testing/index.js";
import { hours, minutes } from "../../src/units/index.js";
import { PurchaseWorkflowStart } from "../flow/fixtures/questions.fixture.js";
import { execute } from "../helpers/flow.js";
import { ClerkAgent, RefundTool, RefundWorkflowStart } from "../channels/pause-targets.fixture.js";
import { PauseShelvesApplication } from "./fixtures/pause-app/pause.application.js";

const quick = testWith(PauseShelvesApplication, { profile: "quick" });
const declared = testWith(PauseShelvesApplication);
const asking = { threadId: "purchase-1", ownerId: "alice" };
const at = (clock: { now(): Date }, delay: number): string =>
  new Date(clock.now().getTime() + delay).toISOString();

const failure = async (profile: string): Promise<ProfileError> => {
  try {
    await applicationOf(PauseShelvesApplication, { profile });
  } catch (error) {
    if (error instanceof ProfileError) return error;
    throw error;
  }
  throw new Error("expected a ProfileError");
};

describe("the external task shelf", () => {
  declared("declared: the pause waits a day", async ({ app, clock }) => {
    const paused = await execute(app, PurchaseWorkflowStart, { text: "laptop for 900" }, asking);

    expect(paused.pending[0]?.expiresAt?.toISOString()).toBe(at(clock, hours(24)));
  });

  quick("a profile's timeout is the pause's deadline", async ({ app, clock }) => {
    const paused = await execute(app, PurchaseWorkflowStart, { text: "laptop for 900" }, asking);

    expect(paused.pending[0]?.expiresAt?.toISOString()).toBe(at(clock, hours(2)));
  });
});

describe("the tool approval shelf", () => {
  declared("declared: four hours", async ({ app, clock, mockModel }) => {
    mockModel(ClerkAgent).thenReturn(callTool(RefundTool, { orderId: "A-1" }));
    const paused = await execute(app, RefundWorkflowStart, { text: "refund A-1" });

    expect(paused.pending[0]?.expiresAt?.toISOString()).toBe(at(clock, hours(4)));
  });

  quick("a profile's timeout is the approval's deadline", async ({ app, clock, mockModel }) => {
    mockModel(ClerkAgent).thenReturn(callTool(RefundTool, { orderId: "A-1" }));
    const paused = await execute(app, RefundWorkflowStart, { text: "refund A-1" });

    expect(paused.pending[0]?.expiresAt?.toISOString()).toBe(at(clock, hours(1)));
  });
});

describe("describe and the rules", () => {
  it("describe prints the deadline and the reminder of the profile", async () => {
    const app = await applicationOf(PauseShelvesApplication, { profile: "quick" });
    const byName = new Map(describedChannelsOf(app).map((channel) => [channel.name, channel]));

    expect(byName.get("refund-tool-approval")).toMatchObject({
      expiresIn: hours(1),
      remindBefore: minutes(10),
    });
    expect(byName.get("spending-limit-external-task")).toMatchObject({ expiresIn: hours(2) });
  });

  it("describe prints the declared ones without a profile", async () => {
    const app = await applicationOf(PauseShelvesApplication);
    const byName = new Map(describedChannelsOf(app).map((channel) => [channel.name, channel]));

    expect(byName.get("refund-tool-approval")).toMatchObject({
      expiresIn: hours(4),
      remindBefore: hours(1),
    });
  });

  it("refuses a name no target has, a target of the other kind, and a deadline under a second", async () => {
    const ghost = await failure("ghost-task");
    expect(ghost.reason).toBe(ProfileErrorReason.Unknown);
    expect(ghost.message).toMatch(/externalTasks\.ghost-external-task: no such @ExternalTask/);
    expect((await failure("wrong-kind")).message).toMatch(
      /toolApprovals\.spending-limit-external-task: no such @ToolApproval/,
    );
    expect((await failure("too-short")).reason).toBe(ProfileErrorReason.Invalid);
  });
});
