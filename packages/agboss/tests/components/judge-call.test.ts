import { ConfigError } from "../../src/core/error-families/config-errors.js";
import { describe, expect, it } from "vitest";
import { LiveJudgeModel, runJudgeCall } from "../../src/components/judge-call.js";
import { JudgeModel } from "../../src/index.js";

/** A judge's metered model, as the agent loop hands it over. */
const metered = (model: string): JudgeModel => ({
  model,
  invoke: (input) => Promise.resolve(`${model}: ${typeof input === "string" ? input : "messages"}`),
  decide: () => Promise.reject(new Error("a chat model")),
});

describe("#280: a judge's model through deps: [JudgeModel]", () => {
  it("each call goes to the model of the judge whose judge() runs", async () => {
    const judgeModel = new LiveJudgeModel("GroundedJudge");

    const reply = await runJudgeCall(metered("local/judge"), () => judgeModel.invoke("ok?"));
    const decided = runJudgeCall(metered("local/judge"), () =>
      judgeModel.decide({ state: "x", questions: {} }),
    );

    expect(judgeModel).toBeInstanceOf(JudgeModel);
    expect(reply).toBe("local/judge: ok?");
    await expect(decided).rejects.toThrow("a chat model");
  });

  it("a sync judge() is awaited like an async one: its value, and its throw as a rejection", async () => {
    const verdict = { passed: true };

    await expect(runJudgeCall(metered("local/judge"), () => verdict)).resolves.toBe(verdict);
    await expect(
      runJudgeCall(metered("local/judge"), () => {
        throw new TypeError("a sync judge broke");
      }),
    ).rejects.toThrow("a sync judge broke");
  });

  it("outside a judge() it names the consumer", () => {
    const judgeModel = new LiveJudgeModel("GroundedJudge");

    expect(() => judgeModel.model).toThrow(ConfigError.Component);
    expect(() => judgeModel.model).toThrow(
      "[judge.model-outside-judge] GroundedJudge used judgeModel.model outside a judge's judge()",
    );
  });
});
