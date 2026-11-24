/**
 * #1307d: 0.1.0's spellings are gone, with no alias and no reading of them — `@ChannelRole({
 * answeredBy })` names nobody (`[channel.role-form]`), a pending pause has no `answeredBy` beside its
 * `answerer`, the described channel has none, a pause record and an answer record have no `responder`,
 * and a stored run or answer entry that carries one is refused (`StoredNamesUnreadableError`).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ComponentError } from "../../src/components/metadata.js";
import { ChannelRole, PauseAnswerer } from "../../src/index.js";
import { channelRoleOf } from "../../src/channels/channel-role.decorator.js";
import { callTool, testWith } from "../../src/testing/index.js";
import { execute } from "../helpers/flow.js";
import {
  ConfirmOrderTool,
  DeskClerkAgent,
  DeskWorkflowStart,
  PausesApplication,
  RefundRequestDto,
  resetPauses,
} from "./fixtures/pauses.workflow.js";

const test = testWith(PausesApplication);

beforeEach(resetPauses);

const OPTIONS = { name: "desk-role", description: "d", approves: RefundRequestDto };

describe("#1307d: @ChannelRole takes answerer only", () => {
  it("answerer assembles", () => {
    @ChannelRole({ ...OPTIONS, answerer: PauseAnswerer.ThreadOwner })
    class NewRole {}
    expect(channelRoleOf(NewRole)?.options.answerer).toBe(PauseAnswerer.ThreadOwner);
  });

  it("answeredBy, alone or beside answerer, is no option: a type error, and no answerer for an untyped caller", () => {
    const declare = () => {
      // @ts-expect-error — 0.1.0's spelling is removed
      @ChannelRole({ ...OPTIONS, answeredBy: PauseAnswerer.Channel })
      class OldRole {}
      return OldRole;
    };
    expect(declare).toThrow(ComponentError);
    expect(declare).toThrow(/\[channel\.role-form\].*answerer/);
    @ChannelRole({
      ...OPTIONS,
      answerer: PauseAnswerer.ThreadOwner,
      // @ts-expect-error — an unknown option, ignored beside the answerer
      answeredBy: PauseAnswerer.Channel,
    })
    class Beside {}
    expect(channelRoleOf(Beside)?.options.answerer).toBe(PauseAnswerer.ThreadOwner);
  });

  it("neither → [channel.role-form] naming answerer", () => {
    const declare = () => {
      // @ts-expect-error — a role names who may answer
      @ChannelRole(OPTIONS)
      class None {}
      return None;
    };
    expect(declare).toThrow(/\[channel\.role-form\].*answerer/);
  });
});

describe("#1307d: no pause shape carries a 0.1.0 alias", () => {
  test("a pending pause has an answerer and no answeredBy", async ({ app, mockLlm }) => {
    mockLlm(DeskClerkAgent).thenReturn(callTool(ConfirmOrderTool, { orderId: "7" }));
    const paused = await execute(
      app,
      DeskWorkflowStart,
      { text: "confirm 7" },
      { ownerId: "alice" },
    );
    const [pending] = paused.pending;
    expect(pending?.answerer).toBe(PauseAnswerer.ThreadOwner);
    expect(Object.keys(pending ?? {})).not.toContain("answeredBy");
  });
});
