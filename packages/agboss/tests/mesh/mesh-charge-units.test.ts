/**
 * #1356 (mesh-charge shard) — what a call across the mesh is charged and under which ledger identity (#810,
 * Q6 c), each rule on its own: a verified report's charge against a contract's price and what the call was
 * charged already, the identity that makes a replay add each charge once, and a call's price charged to the
 * step as the service `a2a:<who>`.
 */
import type { AgentCard } from "@a2a-js/sdk";
import { describe, expect, it } from "vitest";
import { A2AMesh } from "../../src/a2a/client/a2a-guard-errors.js";
import {
  AGBOSS_MESH,
  priceLedgerKeyOf,
  type A2ACharged,
} from "../../src/a2a/client/a2a-mesh-seam.js";
import { serviceUsageOf } from "../../src/components/spend-recorder.js";
import type { UsageRecord } from "../../src/finops/usage.js";
import { runInFrame } from "../../src/flow/context/frame.js";
import { chargeOf, withLedgerKey } from "../../src/mesh/mesh-report.js";
import { testFrame } from "../helpers/frame.js";
import { usd } from "../../src/units/index.js";
import { ConfigError } from "../../src/core/error-families/config-errors.js";

const ACCEPTED = "2026-11-04T12:00:00.000Z";
const NOW = new Date("2026-11-04T12:05:00.000Z");

const report = (total: string, issuer = "peer", issuedAt = "2026-11-04T12:03:00.000Z") =>
  ({
    schema: 1,
    issuer,
    executionId: "task-1",
    spend: { total, currency: "USD" },
    bodyHash: "h",
    issuedAt,
  }) as never;
const contract = (price: number, application = "contract-app") =>
  ({ application, price: usd(price) }) as never;

describe("#1356: what the calling step is charged for a call", () => {
  it("is the price alone without a report, to the contract's application", () => {
    expect(chargeOf(undefined, contract(2), 0)).toEqual({
      application: "contract-app",
      cost: 2,
      tokens: 0,
    });
  });

  it("is the verified spend alone without a contract, to the report's issuer", () => {
    expect(chargeOf(report("3.5"), undefined, 0)).toEqual({
      application: "peer",
      cost: 3.5,
      tokens: 0,
    });
  });

  it("is the larger of the verified spend and the price, to the report's issuer", () => {
    expect(chargeOf(report("3"), contract(2), 0)).toEqual({
      application: "peer",
      cost: 3,
      tokens: 0,
    });
    expect(chargeOf(report("1"), contract(2), 0)).toEqual({
      application: "peer",
      cost: 2,
      tokens: 0,
    });
  });

  it("is the price alone when the report's total is no amount", () => {
    expect(chargeOf(report("many"), contract(2), 0)).toEqual({
      application: "peer",
      cost: 2,
      tokens: 0,
    });
    expect(chargeOf(report("-1"), contract(2), 0)).toEqual({
      application: "peer",
      cost: 2,
      tokens: 0,
    });
  });

  it("is nothing when no application can be charged, however much is owed", () => {
    const anonymous = { ...(report("3") as object), issuer: undefined } as never;
    expect(chargeOf(anonymous, undefined, 0)).toBeUndefined();
    const unnamed = { application: undefined, price: usd(2) } as never;
    expect(chargeOf(anonymous, unnamed, 0)).toBeUndefined();
    expect(chargeOf(anonymous, contract(2), 0)).toEqual({
      application: "contract-app",
      cost: 3,
      tokens: 0,
    });
    expect(chargeOf(undefined, unnamed, 0)).toBeUndefined();
  });

  it("is less what the call was charged already, and nothing at or below it", () => {
    expect(chargeOf(undefined, contract(2), 1)).toEqual({
      application: "contract-app",
      cost: 1,
      tokens: 0,
    });
    expect(chargeOf(undefined, contract(2), 2)).toBeUndefined();
    expect(chargeOf(undefined, contract(2), 3)).toBeUndefined();
    expect(chargeOf(report("5"), contract(2), 2)).toEqual({
      application: "peer",
      cost: 3,
      tokens: 0,
    });
  });

  it("is nothing when there is nothing to charge — no report and no contract, or a report of no spend", () => {
    expect(chargeOf(undefined, undefined, 0)).toBeUndefined();
    expect(chargeOf(report("0"), undefined, 0)).toBeUndefined();
  });
});

describe("#1382: a price or a charge that is no amount throws, never counts", () => {
  const bad = [-1, -0.5, Number.NaN, Number.POSITIVE_INFINITY];

  it.each(bad)(
    "a contract price of %s is a ConfigError.Unit, not a charge of %s above the report",
    (price) => {
      expect(() => chargeOf(report("3"), { application: "a", price } as never, 0)).toThrow(
        ConfigError.Unit,
      );
      expect(() => chargeOf(undefined, { application: "a", price } as never, 0)).toThrow(
        ConfigError.Unit,
      );
    },
  );

  it.each(bad)(
    "a call already charged %s is a ConfigError.Unit, not a charge raised by it",
    (charged) => {
      expect(() => chargeOf(report("3"), undefined, charged)).toThrow(ConfigError.Unit);
      expect(() => chargeOf(undefined, contract(2), charged)).toThrow(ConfigError.Unit);
    },
  );

  it("a price of 0 and a charge of 0 are amounts", () => {
    expect(chargeOf(report("3"), contract(0), 0)).toEqual({
      application: "peer",
      cost: 3,
      tokens: 0,
    });
  });
});

describe("#1356: the ledger identity of a report's charge", () => {
  const spent = serviceUsageOf({ service: "mesh:peer", cost: usd(1) });
  const identity = { id: "a2a:m-1:report", notBefore: ACCEPTED, now: NOW };

  it("leaves a charge of a call with no identity as it is", () => {
    expect(withLedgerKey(spent, undefined, report("1"))).toBe(spent);
  });

  it("gives the charge the call's ledger id and the report's date inside the caller's window", () => {
    const keyed = withLedgerKey(spent, identity, report("1"));

    expect(keyed).toEqual({
      ...spent,
      ledgerKey: { id: "a2a:m-1:report", madeAt: new Date("2026-11-04T12:03:00.000Z") },
    });
  });

  it("dates a charge with no report at the caller's time now", () => {
    expect(withLedgerKey(spent, identity, undefined).ledgerKey?.madeAt).toEqual(NOW);
  });
});

describe("#1356: a call's price", () => {
  const charged: A2ACharged = {
    messageId: "m-1",
    acceptedAt: ACCEPTED,
    bodyHash: undefined,
    taskId: undefined,
    now: NOW,
  };
  const call = (application: string | undefined) => ({
    agent: "billing",
    application,
    skill: undefined,
    mesh: A2AMesh.IfSupported,
  });
  const card = { capabilities: {} } as AgentCard;
  const peer = { kind: "foreign" } as never;

  const chargedFor = async (price: number | undefined, application: string | undefined) => {
    const reported: UsageRecord[] = [];
    const frame = {
      ...testFrame(),
      services: { reportUsage: (usage: UsageRecord) => reported.push(usage) },
    };
    await runInFrame(frame, () => {
      AGBOSS_MESH.activate(card, peer, call(application)).charge(
        price === undefined ? undefined : usd(price),
        charged,
      );
      return Promise.resolve();
    });
    return reported;
  };

  it("is charged to the step as the service a2a:<application>, at its price, under the call's price identity", async () => {
    expect(await chargedFor(0.5, "partner")).toEqual([
      {
        ...serviceUsageOf({ service: "a2a:partner", cost: usd(0.5) }),
        ledgerKey: { id: "a2a:m-1:price", madeAt: new Date(ACCEPTED) },
      },
    ]);
  });

  it("is charged under the agent's name when the call names no application", async () => {
    expect((await chargedFor(0.5, undefined))[0]?.model).toBe("a2a:billing");
  });

  it.each([-1, -0.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "a price of %s is refused with a ConfigError.Unit before anything is charged (#1382)",
    async (price) => {
      const reported: UsageRecord[] = [];
      const frame = {
        ...testFrame(),
        services: { reportUsage: (usage: UsageRecord) => reported.push(usage) },
      };
      await expect(
        runInFrame(frame, () => {
          AGBOSS_MESH.activate(card, peer, call("partner")).charge(price as never, charged);
          return Promise.resolve();
        }),
      ).rejects.toThrow(ConfigError.Unit);
      expect(reported).toEqual([]);
    },
  );

  it("is no charge at no price, or a price of 0", async () => {
    expect(await chargedFor(undefined, "partner")).toEqual([]);
    expect(await chargedFor(0, "partner")).toEqual([]);
  });

  it("is charged to no one by a step whose frame has no spend service", async () => {
    await expect(
      runInFrame({ ...testFrame(), services: {} }, () => {
        AGBOSS_MESH.activate(card, peer, call("partner")).charge(usd(1), charged);
        return Promise.resolve("done");
      }),
    ).resolves.toBe("done");
  });

  it("is dated by the call's accept as stored, under the id of its message", () => {
    expect(
      priceLedgerKeyOf({ ...charged, messageId: "m-9", acceptedAt: "2026-01-01T00:00:00.000Z" }),
    ).toEqual({
      id: "a2a:m-9:price",
      madeAt: new Date("2026-01-01T00:00:00.000Z"),
    });
  });

  it("is charged to no one outside a step", () => {
    expect(() => {
      AGBOSS_MESH.activate(card, peer, call("partner")).charge(usd(1), charged);
    }).not.toThrow();
  });
});
