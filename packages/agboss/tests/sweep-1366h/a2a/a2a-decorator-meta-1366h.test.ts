/**
 * #1366: `@A2AAgent` records exactly what was declared: an option left out leaves no key at all
 * (not an `undefined` one), a declared one is kept as given, `allowedOrigins` is copied (a later
 * change of the caller's array never reaches the record), and `deps` default to none.
 */
import { describe, expect, it } from "vitest";
import { A2AAgent } from "../../../src/a2a/a2a-decorator.js";
import { A2AClient } from "../../../src/a2a/client/a2a-client.js";
import { A2AMesh } from "../../../src/a2a/client/a2a-guard-errors.js";
import { componentOf } from "../../../src/components/metadata.js";
import { Text } from "../../../src/dto/index.js";
import { usd } from "../../../src/units/index.js";

class QuestionDto {
  @Text()
  question!: string;
}

class AnswerDto {
  @Text()
  answer!: string;
}

const metaOf = (cls: object) => {
  const component = componentOf(cls);
  if (component?.kind !== "a2a-agent") throw new Error("not an a2a-agent");
  return component.meta;
};

describe("#1366 @A2AAgent's record", () => {
  it("only name, url and deps when nothing else is declared", () => {
    @A2AAgent({ name: "bare-a2a-agent", url: "http://a.invalid" })
    class Bare extends A2AClient {}
    const meta = metaOf(Bare);
    expect(Object.keys(meta).sort()).toEqual(["deps", "name", "url"]);
    expect(meta.deps).toEqual([]);
  });

  it("everything declared is kept, allowedOrigins as a copy", () => {
    const origins = ["http://a.invalid", "http://b.invalid"];
    @A2AAgent({
      name: "full-a2a-agent",
      url: "http://a.invalid",
      target: { application: "peer-application", skill: "ask" },
      input: QuestionDto,
      output: AnswerDto,
      costPerCall: usd(0.05),
      mesh: A2AMesh.Required,
      allowedOrigins: origins,
    })
    class Full extends A2AClient<QuestionDto, AnswerDto> {}
    const meta = metaOf(Full);
    expect(meta).toEqual({
      name: "full-a2a-agent",
      url: "http://a.invalid",
      target: { application: "peer-application", skill: "ask" },
      input: QuestionDto,
      output: AnswerDto,
      costPerCall: usd(0.05),
      mesh: A2AMesh.Required,
      allowedOrigins: ["http://a.invalid", "http://b.invalid"],
      deps: [],
    });
    expect(meta.allowedOrigins).not.toBe(origins);
    origins.push("http://c.invalid");
    expect(meta.allowedOrigins).toHaveLength(2);
  });

  it("an empty allowedOrigins is kept as an empty list", () => {
    @A2AAgent({ name: "empty-a2a-agent", url: "http://a.invalid", allowedOrigins: [] })
    class Empty extends A2AClient {}
    expect(metaOf(Empty).allowedOrigins).toEqual([]);
  });
});
