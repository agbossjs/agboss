/**
 * #1366 (ledger-a2a-client shard) — which providers of an application the contract rules read as A2A agents: only a
 * class declared with `@A2AAgent` is one (any other provider is passed over, whatever it is), and one whose class name
 * lacks the `A2AAgent` suffix is told so.
 */
import { describe, expect, it, vi } from "vitest";
import { ComponentOptions } from "../../src/components/component-options.js";
import { contractRuleViolations } from "../../src/a2a/a2a-rules.js";
import { componentOf } from "../../src/components/metadata.js";

vi.mock("../../src/components/metadata.js", async (original) => ({
  ...(await original<typeof import("../../src/components/metadata.js")>()),
  componentOf: vi.fn(),
}));

class Peer {
  readonly peer = true;
}
class Plain {
  readonly plain = true;
}

const options = (...providers: object[]) => ({ name: "desk", providers, workflows: [] }) as never;

describe("#1366: the providers the A2A agent rules read", () => {
  it("a class that is no component is passed over, and so is one that is another kind", () => {
    vi.mocked(componentOf).mockImplementation(((cls: object) =>
      cls === Plain ? undefined : { kind: "agent", meta: { name: "x" } }) as never);

    expect(contractRuleViolations(options(Plain, Peer), ComponentOptions.none)).toEqual([]);
  });

  it("an @A2AAgent needs no class-name suffix (#1343a)", () => {
    vi.mocked(componentOf).mockReturnValue({
      kind: "a2a-agent",
      meta: { name: "peer", target: {} },
    } as never);

    const found = contractRuleViolations(options(Peer), ComponentOptions.none);

    expect(found).toEqual([]);
  });

  it("a name that is not kebab-case is told on its decorator", () => {
    vi.mocked(componentOf).mockReturnValue({
      kind: "a2a-agent",
      meta: { name: "Peer_X", target: {} },
    } as never);

    const found = contractRuleViolations(options(Peer), ComponentOptions.none);

    expect(found).toEqual([
      {
        code: "name.not-kebab-case",
        message: '"Peer_X" on @A2AAgent — a name is kebab-case: "peer-x"',
        nodes: ["desk"],
      },
    ]);
  });
});
