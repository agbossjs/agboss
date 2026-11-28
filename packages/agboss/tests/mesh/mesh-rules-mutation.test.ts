/**
 * #1356 (mutation shard `a2a-server`): the mesh's assembly rules on their own — every number's edge,
 * the replay window, the peers, with each violation's code, text and nodes.
 */
import { describe, expect, it } from "vitest";
import { secret } from "../../src/environments/secret.js";
import { meshRuleViolations } from "../../src/mesh/mesh-rules.js";
import { Mesh, MeshInboundMode, type MeshOptions } from "../../src/mesh/mesh.decorator.js";
import { seconds, type Milliseconds } from "../../src/units/index.js";

/** A number as the mesh holds it, whatever it is: a JavaScript caller's needs no unit. */
const ms = (amount: number): Milliseconds => amount as Milliseconds;

const APP = "edge-application";

/** A mesh class holding `overrides` over a sound one: 8 hops, a deduplication of ten minutes. */
function meshWith(overrides: Partial<MeshOptions> = {}) {
  @Mesh({
    name: "edge-mesh",
    inboundMode: MeshInboundMode.Strict,
    deduplicationTtl: seconds(600),
    maxHops: 8,
    ...overrides,
  })
  class EdgeMesh {}
  return EdgeMesh;
}

const violationsOf = (
  overrides: Partial<MeshOptions> = {},
  endpoints: readonly (new () => object)[] = [],
) => meshRuleViolations(APP, meshWith(overrides), endpoints);

/** What is found besides the replay window's (a number that is no number makes a window that is none). */
const withoutWindow = (found: ReturnType<typeof violationsOf>) =>
  found.filter(({ message }) => !message.includes("is shorter than envelopeTtl"));

const limit = (text: string) => ({
  code: "mesh.limit-invalid",
  message: `edge-mesh: ${text}`,
  nodes: [APP],
});

describe("a mesh that is no @Mesh, or none", () => {
  it("none: nothing to check", () => {
    expect(meshRuleViolations(APP, undefined)).toEqual([]);
  });

  it("a plain class is `mesh.not-a-mesh`, named by its class", () => {
    class Plain {
      readonly kind = "plain";
    }

    expect(meshRuleViolations(APP, Plain)).toEqual([
      {
        code: "mesh.not-a-mesh",
        message:
          "@Application({ mesh }) is Plain, which is no @Mesh({ inboundMode, deduplicationTtl, maxHops })",
        nodes: [APP],
      },
    ]);
  });

  it("a class with no name is `a class`", () => {
    const [nameless] = [
      class {
        readonly kind = "nameless";
      },
    ];

    expect(meshRuleViolations(APP, nameless as new () => object)[0]?.message).toBe(
      "@Application({ mesh }) is a class, which is no @Mesh({ inboundMode, deduplicationTtl, maxHops })",
    );
  });
});

describe("a sound mesh", () => {
  it("has no violation, at its edges: one hop, a deduplication one ms above the window", () => {
    expect(violationsOf()).toEqual([]);
    expect(violationsOf({ maxHops: 1 })).toEqual([]);
    expect(
      violationsOf({ envelopeTtl: ms(1), maxClockSkew: ms(0), deduplicationTtl: ms(61_000) }),
    ).toEqual([]);
    expect(violationsOf({ maxClockSkew: ms(0) })).toEqual([]);
  });
});

describe("the hops", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])("%s is refused", (maxHops) => {
    expect(violationsOf({ maxHops })).toEqual([
      {
        code: "limits.max-mesh-hops-invalid",
        message: `edge-mesh's maxHops is ${String(maxHops)}, not a whole number of applications from 1 — @Mesh({ maxHops: 6 }) refuses a call chain that already passed through 6 applications`,
        nodes: [APP],
      },
    ]);
  });

  it("a text is refused as well", () => {
    expect(violationsOf({ maxHops: "8" as never })[0]).toMatchObject({
      code: "limits.max-mesh-hops-invalid",
      message: expect.stringContaining("edge-mesh's maxHops is 8,") as string,
    });
  });
});

describe("the deduplication", () => {
  it.each([
    [seconds(30), "30000"],
    [ms(0), "0"],
    [ms(-5), "-5"],
    [ms(Number.NaN), "NaN"],
    [ms(Number.POSITIVE_INFINITY), "Infinity"],
  ])("%s ms is not a duration above the lease", (deduplicationTtl, text) => {
    expect(withoutWindow(violationsOf({ deduplicationTtl }))).toEqual([
      limit(`deduplicationTtl is ${text} ms, not a duration above the lease's 30000 ms`),
    ]);
  });

  it("shorter than the replay window is refused with the window: envelope + 2 skews + the sweep", () => {
    expect(violationsOf({ deduplicationTtl: ms(179_999) })).toEqual([
      limit(
        "deduplicationTtl 179999 ms is shorter than envelopeTtl + 2 × maxClockSkew + the sweep's granularity (180000 ms): a signed request could be replayed after it is forgotten",
      ),
    ]);
    expect(violationsOf({ deduplicationTtl: ms(180_000) })).toEqual([]);
  });

  it("the window follows the mesh's own envelope lifetime and skew", () => {
    // 1000 + 2 × 100 + 60000
    expect(
      violationsOf({ envelopeTtl: ms(1_000), maxClockSkew: ms(100), deduplicationTtl: ms(61_199) }),
    ).toEqual([
      limit(
        "deduplicationTtl 61199 ms is shorter than envelopeTtl + 2 × maxClockSkew + the sweep's granularity (61200 ms): a signed request could be replayed after it is forgotten",
      ),
    ]);
    expect(
      violationsOf({ envelopeTtl: ms(1_000), maxClockSkew: ms(100), deduplicationTtl: ms(61_200) }),
    ).toEqual([]);
  });
});

describe("the envelope's lifetime and the clock skew", () => {
  it.each([
    [0, "0"],
    [-1, "-1"],
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "Infinity"],
  ])("an envelopeTtl of %s is refused", (envelopeTtl, text) => {
    expect(withoutWindow(violationsOf({ envelopeTtl: ms(envelopeTtl) }))).toEqual([
      limit(`envelopeTtl is ${text} ms, not a positive duration`),
    ]);
  });

  it.each([
    [-1, "-1"],
    [Number.NaN, "NaN"],
    [Number.POSITIVE_INFINITY, "Infinity"],
  ])("a maxClockSkew of %s is refused", (maxClockSkew, text) => {
    expect(
      withoutWindow(
        violationsOf({ maxClockSkew: ms(maxClockSkew), deduplicationTtl: seconds(6_000) }),
      ),
    ).toEqual([limit(`maxClockSkew is ${text} ms, not a duration from 0`)]);
  });

  it("a skew that is no number is refused", () => {
    expect(violationsOf({ maxClockSkew: "5" as never })[0]).toMatchObject({
      code: "mesh.limit-invalid",
      message: "edge-mesh: maxClockSkew is 5 ms, not a duration from 0",
    });
  });
});

describe("the peers", () => {
  const key = secret("PEER_KEY");
  class OrdersEndpoint {
    readonly kind = "orders";
  }
  class BillingEndpoint {
    readonly kind = "billing";
  }

  it("each once, with a key, calling listed endpoints: none", () => {
    expect(
      violationsOf(
        {
          peers: [
            { application: "alpha", verifyKeys: [key], allowEndpoints: [OrdersEndpoint] },
            { application: "beta", verifyKeys: [key] },
          ],
        },
        [OrdersEndpoint, BillingEndpoint],
      ),
    ).toEqual([]);
  });

  it("a peer listed twice", () => {
    expect(
      violationsOf({
        peers: [
          { application: "alpha", verifyKeys: [key] },
          { application: "alpha", verifyKeys: [key] },
        ],
      }),
    ).toEqual([
      {
        code: "mesh.duplicate-peer",
        message: "edge-mesh lists peer alpha twice — one entry per peer, its keys in verifyKeys",
        nodes: [APP],
      },
    ]);
  });

  it("a peer with no key", () => {
    expect(violationsOf({ peers: [{ application: "alpha", verifyKeys: [] }] })).toEqual([
      {
        code: "mesh.peer-without-keys",
        message: "edge-mesh's peer alpha lists no verifyKeys — a peer with no key verifies nothing",
        nodes: [APP],
      },
    ]);
  });

  it("an endpoint the application does not list, one violation per such endpoint", () => {
    expect(
      violationsOf(
        {
          peers: [
            {
              application: "alpha",
              verifyKeys: [key],
              allowEndpoints: [OrdersEndpoint, BillingEndpoint],
            },
          ],
        },
        [OrdersEndpoint],
      ),
    ).toEqual([
      {
        code: "mesh.unknown-endpoint",
        message:
          "edge-mesh's peer alpha may call BillingEndpoint, which @Application({ endpoints }) does not list",
        nodes: [APP],
      },
    ]);
  });

  it("with no endpoint listed at all, every one a peer names is unknown", () => {
    expect(
      meshRuleViolations(
        APP,
        meshWith({
          peers: [{ application: "alpha", verifyKeys: [key], allowEndpoints: [OrdersEndpoint] }],
        }),
      ).map(({ code }) => code),
    ).toEqual(["mesh.unknown-endpoint"]);
  });
});

describe("the order of what is found", () => {
  it("the numbers, then the replay window, then the peers", () => {
    const codes = violationsOf({
      maxHops: 0,
      deduplicationTtl: ms(100_000),
      peers: [{ application: "alpha", verifyKeys: [] }],
    }).map(({ code }) => code);

    expect(codes).toEqual([
      "limits.max-mesh-hops-invalid",
      "mesh.limit-invalid",
      "mesh.peer-without-keys",
    ]);
  });
});
