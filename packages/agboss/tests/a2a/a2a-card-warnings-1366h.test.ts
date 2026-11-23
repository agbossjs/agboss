/**
 * #1366: the A2A assembly warnings read the declarations exactly: a skill without tags is named
 * once per untagged start (an export that is no start is skipped, never a crash), an `@A2AAgent`
 * without a price and without an AGBoss `target.application` is named wherever it is listed
 * (providers or modules, each once), and nothing else is named.
 */
import { describe, expect, it } from "vitest";
import { A2AAgent } from "../../src/a2a/a2a-decorator.js";
import { a2aCardWarningsOf } from "../../src/a2a/a2a-card-warnings.js";
import { A2AExpose } from "../../src/a2a/a2a-expose.decorator.js";
import { A2AClient } from "../../src/a2a/client/a2a-client.js";
import { recordComponent } from "../../src/components/metadata.js";
import { usd } from "../../src/units/index.js";
import { RefundWorkflowStart } from "./fixtures/contracts.workflow.js";

type Sources = Parameters<typeof a2aCardWarningsOf>[0];

const sourcesOf = (over: Partial<Sources>): Sources => ({
  providers: [],
  budgets: [],
  workflows: [],
  ...over,
});

class NotAStart {
  readonly kind = "not-a-start";
}
class NotAnExpose {
  readonly kind = "not-an-expose";
}

@A2AAgent({ name: "foreign-a2a-agent", url: "http://f.invalid" })
class ForeignAgent extends A2AClient {}

@A2AAgent({ name: "priced-a2a-agent", url: "http://p.invalid", price: usd(0.01) })
class PricedAgent extends A2AClient {}

@A2AAgent({
  name: "peer-a2a-agent",
  url: "http://b.invalid",
  target: { application: "peer-application", skill: "x" },
})
class PeerAgent extends A2AClient {}

@A2AAgent({ name: "second-a2a-agent", url: "http://s.invalid" })
class SecondForeignAgent extends A2AClient {}

@A2AExpose({
  name: "tags-a2a-expose",
  version: "1.0.0",
  description: "d",
  exports: [RefundWorkflowStart],
})
class UntaggedExpose {}

@A2AExpose({
  name: "tagged-a2a-expose",
  version: "1.0.0",
  description: "d",
  exports: [RefundWorkflowStart],
  skills: { "refund-workflow-start": { tags: ["refunds"] } },
})
class TaggedExpose {}

class ExposeOfNonStart {
  readonly kind = "expose-of-non-start";
}
recordComponent(ExposeOfNonStart, {
  kind: "a2a-expose",
  meta: { name: "odd-a2a-expose", version: "1.0.0", description: "d", exports: [NotAStart] },
});

describe("#1366 [a2a.skill-tags]", () => {
  it("names an untagged skill once; an undeclared export and a non-expose are skipped", () => {
    const warnings = a2aCardWarningsOf(
      sourcesOf({
        name: "app",
        exposes: [UntaggedExpose, TaggedExpose, ExposeOfNonStart, NotAnExpose, ForeignAgent],
      }),
    );
    expect(warnings.map((warning) => warning.code)).toEqual(["a2a.skill-tags"]);
    expect(warnings[0]?.message).toContain("tags-a2a-expose");
  });

  it("no exposes at all: nothing is named", () => {
    expect(a2aCardWarningsOf(sourcesOf({}))).toEqual([]);
    expect(a2aCardWarningsOf(sourcesOf({ exposes: [] }))).toEqual([]);
  });
});

describe("#1366 [a2a.unpriced-foreign-peer]", () => {
  const namedOf = (sources: Sources) =>
    a2aCardWarningsOf(sources).map(
      (warning) => `${warning.code}|${warning.message.split(" ")[0] ?? ""}`,
    );

  it("names only a foreign agent without a price, in providers or modules, each once", () => {
    expect(
      namedOf(
        sourcesOf({
          providers: [ForeignAgent, PricedAgent, PeerAgent, NotAnExpose, ForeignAgent],
          modules: [
            { owner: "w", providers: [SecondForeignAgent, ForeignAgent, PricedAgent] },
            { owner: "v", providers: [{ provide: "x", useValue: 1 } as never] },
          ],
        }),
      ),
    ).toEqual([
      "a2a.unpriced-foreign-peer|foreign-a2a-agent",
      "a2a.unpriced-foreign-peer|second-a2a-agent",
    ]);
  });

  it("without modules, the providers alone are read", () => {
    expect(namedOf(sourcesOf({ providers: [ForeignAgent] }))).toEqual([
      "a2a.unpriced-foreign-peer|foreign-a2a-agent",
    ]);
  });

  it("an agent only a module lists is named", () => {
    expect(
      namedOf(sourcesOf({ modules: [{ owner: "w", providers: [SecondForeignAgent] }] })),
    ).toEqual(["a2a.unpriced-foreign-peer|second-a2a-agent"]);
  });

  it("an AGBoss peer or a priced agent leaves no warning at all", () => {
    expect(a2aCardWarningsOf(sourcesOf({ providers: [PeerAgent, PricedAgent] }))).toEqual([]);
  });

  it("a provider that is no class is never read as an agent, even with a component recorded", () => {
    const fake = { provide: "x" };
    recordComponent(fake, {
      kind: "a2a-agent",
      meta: { name: "fake-a2a-agent", url: "http://x.invalid", deps: [] },
    });
    expect(a2aCardWarningsOf(sourcesOf({ providers: [fake as never] }))).toEqual([]);
  });
});
