/**
 * #1356 (shard `a2a-direct`): what a direct attempt's run becomes — a run a cancel or a stop ended is no reply (the
 * attempt fails as a cancel: its row is gone), a reply's output is masked by the class of the finish the run reached
 * and no other, and what the run spent is kept with its tokens.
 */
import { describe, expect, it } from "vitest";
import { directReply } from "../../../src/a2a/server/a2a-direct-reply.js";
import { messageSkillsOf } from "../../../src/a2a/a2a-message-skill-rule.js";
import { A2AReply } from "../../../src/a2a/a2a-endpoint.decorator.js";
import { ExecutionStatus } from "../../../src/app/types.js";
import { CostReport } from "../../../src/finops/usage.js";
import { usd } from "../../../src/units/index.js";
import { DeskMessageDto } from "../../pii/sensitive.fixture.js";
import { RefundWorkflowStart } from "../fixtures/contracts.workflow.js";
import { callerOf, messageOf, refusalOf } from "../server/support/unit-parts.js";
import { DIRECT_SKILL, directRig, finished, KEY } from "./support/direct-parts.js";

const hello = () => messageOf("m-1", ["hello"], { contextId: "ctx-7" });

describe("#1356: an attempt whose run was cancelled or stopped", () => {
  it.each([ExecutionStatus.Cancelled, ExecutionStatus.Stopped])(
    "%s: no reply, the attempt fails as a cancel and its row is removed",
    async (status) => {
      const rig = directRig();
      rig.script = () => Promise.resolve(Object.assign(finished(), { status }));

      const refused = await refusalOf(directReply(rig.parts, callerOf(), hello(), DIRECT_SKILL));

      expect(refused).toMatch(
        /^ExecutionCancelledError.*: the execution was cancelled externally$/u,
      );
      expect(await rig.messages.findByKey(KEY)).toBeUndefined();
    },
  );
});

describe("#1356: the reply of a finished run", () => {
  const masking = (outputs: typeof DIRECT_SKILL.outputs) => ({
    ...DIRECT_SKILL,
    outputs,
  });
  const output = (finish: string, classes: (typeof DIRECT_SKILL.outputs)[number]["classes"]) =>
    DIRECT_SKILL.outputs.map((served) => ({ ...served, finish, classes }));

  it("is masked by the class of the finish it reached, never by another finish's", async () => {
    const rig = directRig();
    rig.script = () =>
      Promise.resolve(Object.assign(finished(), { output: { text: "a", author: "zoe-7-secret" } }));
    const skill = masking([
      ...output("other-workflow-finish", []),
      ...output("unit-workflow-finish", [DeskMessageDto]),
    ]);

    await directReply(rig.parts, callerOf(), hello(), skill);

    expect((await rig.messages.findByKey(KEY))?.reply).toMatchObject({
      finish: "unit-workflow-finish",
      output: { text: "a", author: "<author>" },
    });
  });

  it("is kept as it is when its finish has no class listed", async () => {
    const rig = directRig();
    rig.script = () =>
      Promise.resolve(Object.assign(finished(), { output: { text: "a", author: "zoe-7-secret" } }));
    const skill = masking(output("other-workflow-finish", [DeskMessageDto]));

    await directReply(rig.parts, callerOf(), hello(), skill);

    expect((await rig.messages.findByKey(KEY))?.reply?.output).toEqual({
      text: "a",
      author: "zoe-7-secret",
    });
  });

  it("keeps what the run spent, tokens included", async () => {
    const rig = directRig();
    rig.script = () =>
      Promise.resolve(
        Object.assign(finished(), {
          spend: { ...CostReport.fromUsage([]), totalUsd: usd(0.5), totalTokens: 321 },
        }),
      );

    await directReply(rig.parts, callerOf(), hello(), DIRECT_SKILL);

    expect((await rig.messages.findByKey(KEY))?.reply).toMatchObject({
      spentUsd: 0.5,
      spentTokens: 321,
    });
  });
});

describe("#1356: the skills of an endpoint that answer with a message", () => {
  it("are the starts listed with that reply, and none listed with another", () => {
    expect(
      messageSkillsOf({
        skills: [{ start: RefundWorkflowStart, reply: A2AReply.Message }],
      } as never),
    ).toEqual([RefundWorkflowStart]);
    expect(
      messageSkillsOf({ skills: [{ start: RefundWorkflowStart, reply: A2AReply.Task }] } as never),
    ).toEqual([]);
    expect(messageSkillsOf({ skills: [RefundWorkflowStart] } as never)).toEqual([]);
  });
});
