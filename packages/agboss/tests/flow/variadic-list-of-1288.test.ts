/**
 * #1288a: `listOf(A, B, …)` is one flat call for a homogeneous and a polymorphic list; an action
 * returns plain literals for a `oneOf` / polymorphic list and the runtime tells the class by its strict
 * schema; two classes one plain value could both satisfy fail at assembly with `[dto.ambiguous-one-of]`.
 */
import { describe, expect, it } from "vitest";
import { checkWorkflow } from "../../src/flow/analyse/analyse.js";
import { Action } from "../../src/flow/decorators/action.js";
import { Workflow } from "../../src/flow/decorators/workflow.js";
import { listOf, oneOf, Wrapper } from "../../src/flow/dto-wrappers.js";
import { checkedActionValue } from "../../src/flow/runtime/runners/action.js";
import { Enum, Integer, Text } from "../../src/dto/index.js";
import { ambiguousPairOf } from "../../src/dto/ambiguity.js";
import { onStart } from "./fixtures/paths.js";
import { KitWorkflowStart } from "./fixtures/kit.fixture.js";
import { Ttl } from "../../src/index.js";

class ScoreDto {
  @Text() vendor!: string;
  @Integer() score!: number;
}

class RejectedDto {
  @Text() vendor!: string;
  @Text() reason!: string;
}

class FailedDto {
  @Text() vendor!: string;
  @Text() error!: string;
}

/** Same fields as `ScoreDto`, optional extras: a plain value of either shape fits both. */
class LooseScoreDto {
  @Text() vendor!: string;
  @Integer({ optional: true }) score?: number;
}

class KindADto {
  @Enum(["a"]) kind!: "a";
}

class KindBDto {
  @Enum(["b"]) kind!: "b";
}

describe("#1288a: variadic listOf", () => {
  it("one class is a homogeneous list, several are a polymorphic one", () => {
    const one = listOf(ScoreDto);
    const many = listOf(ScoreDto, RejectedDto, FailedDto);

    expect(one.kind).toBe(Wrapper.List);
    expect(one.element).toBe(ScoreDto);
    expect(one.variants).toEqual([ScoreDto]);
    expect(many.variants).toEqual([ScoreDto, RejectedDto, FailedDto]);
    expect(many.element).toEqual(oneOf(ScoreDto, RejectedDto, FailedDto));
    expect(Object.isFrozen(many)).toBe(true);
    expect(Object.isFrozen(many.variants)).toBe(true);
  });

  it("reads the wrapped form the same way until the flow flip removes it", () => {
    expect(listOf(ScoreDto, RejectedDto).variants).toEqual([ScoreDto, RejectedDto]);
  });
});

describe("#1288a: an action returns plain literals for a polymorphic output", () => {
  it("a oneOf value is of the class whose strict schema accepts it", () => {
    const output = oneOf(ScoreDto, RejectedDto);

    const score = checkedActionValue("vendor-action", output, { vendor: "Acme", score: 3 });
    const rejected = checkedActionValue("vendor-action", output, { vendor: "Acme", reason: "x" });

    expect(score.variant).toBe("ScoreDto");
    expect(score.value).toBeInstanceOf(ScoreDto);
    expect(rejected.variant).toBe("RejectedDto");
    expect(rejected.value).toBeInstanceOf(RejectedDto);
  });

  it("a polymorphic list tells each item's class", () => {
    const { value } = checkedActionValue(
      "vendor-action",
      listOf(ScoreDto, RejectedDto, FailedDto),
      [
        { vendor: "A", score: 1 },
        { vendor: "B", error: "down" },
      ],
    );

    expect(value).toEqual([
      { variant: "ScoreDto", value: { vendor: "A", score: 1 } },
      { variant: "FailedDto", value: { vendor: "B", error: "down" } },
    ]);
  });

  it("a value that fits no class is refused without echoing it", () => {
    expect(() =>
      checkedActionValue("vendor-action", oneOf(ScoreDto, RejectedDto), { secret: "token-123" }),
    ).toThrow(/vendor-action has output oneOf\(ScoreDto, RejectedDto\)/);
  });
});

describe("#1288a: [dto.ambiguous-one-of]", () => {
  it("tells distinguishable classes from ambiguous ones", () => {
    expect(ambiguousPairOf([ScoreDto, RejectedDto, FailedDto])).toBeUndefined();
    expect(ambiguousPairOf([KindADto, KindBDto])).toBeUndefined();
    expect(ambiguousPairOf([ScoreDto, LooseScoreDto])).toEqual([ScoreDto, LooseScoreDto]);
  });

  const check = (output: unknown, name: string) => {
    @Action({ name: `${name}-action`, description: "d", output: output as never })
    class Vendor {
      execute(): unknown {
        return undefined;
      }
    }
    @Workflow({
      name: `${name}-workflow`,
      version: "1.0.0",
      historyTtl: Ttl.Forever,
      flow: [onStart(KitWorkflowStart).toAction(Vendor)],
    })
    class Checked {}
    return checkWorkflow(Checked).errors.filter((found) => found.code === "dto.ambiguous-one-of");
  };

  it("an action oneOf of two classes a plain value could both be fails assembly", () => {
    const found = check(oneOf(ScoreDto, LooseScoreDto), "ambiguous-one");

    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("ScoreDto and LooseScoreDto");
  });

  it("so does a polymorphic list", () => {
    expect(
      check(listOf(RejectedDto, FailedDto, ScoreDto, LooseScoreDto), "ambiguous-list"),
    ).toHaveLength(1);
  });

  it("distinguishable classes pass", () => {
    expect(check(oneOf(ScoreDto, RejectedDto), "plain-one")).toEqual([]);
    expect(check(listOf(KindADto, KindBDto), "plain-list")).toEqual([]);
  });
});
