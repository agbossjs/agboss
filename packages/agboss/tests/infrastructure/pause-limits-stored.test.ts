/**
 * #1307, Q-D: how a move to another target narrows the limits a pause carries — each field the
 * smaller of the record's and the destination's offer, never larger, and an absent side never loosens.
 */
import { describe, expect, it } from "vitest";
import { narrowedLimits } from "../../src/infrastructure/pause-limits-stored.js";

const EARLY = "2026-01-05T10:00:00.000Z";
const LATE = "2026-01-06T10:00:00.000Z";

describe("narrowedLimits", () => {
  it("takes the smaller of each field, the record's or the destination's", () => {
    const held = {
      maxExpiresAt: LATE,
      escalationLimits: { maxExtensions: 5, maxReassignments: 1 },
    };

    expect(
      narrowedLimits(held, {
        maxExpiresAt: EARLY,
        escalationLimits: { maxExtensions: 9, maxReassignments: 0 },
      }),
    ).toEqual({
      maxExpiresAt: EARLY,
      escalationLimits: { maxExtensions: 5, maxReassignments: 0 },
    });
    expect(narrowedLimits({ ...held, maxExpiresAt: EARLY }, { maxExpiresAt: LATE })).toMatchObject({
      maxExpiresAt: EARLY,
    });
  });

  it("an offer that names nothing, or a pause that names nothing, loosens nothing and invents nothing", () => {
    const held = { maxExpiresAt: EARLY, escalationLimits: { maxExtensions: 2 } };

    expect(narrowedLimits(held)).toEqual(held);
    expect(narrowedLimits(held, {})).toEqual(held);
    expect(narrowedLimits(held, { escalationLimits: {} })).toEqual(held);
    expect(narrowedLimits({ escalationLimits: {} }, {})).toEqual({ escalationLimits: {} });
    // a limit the pause had none of is the destination's
    expect(
      narrowedLimits(
        { escalationLimits: {} },
        { maxExpiresAt: LATE, escalationLimits: { maxReassignments: 0 } },
      ),
    ).toEqual({ maxExpiresAt: LATE, escalationLimits: { maxReassignments: 0 } });
  });

  it("a count of zero is a limit, not an absent one", () => {
    expect(
      narrowedLimits(
        { escalationLimits: { maxExtensions: 0 } },
        { escalationLimits: { maxExtensions: 3 } },
      ),
    ).toEqual({ escalationLimits: { maxExtensions: 0 } });
    expect(
      narrowedLimits(
        { escalationLimits: { maxExtensions: 3 } },
        { escalationLimits: { maxExtensions: 0 } },
      ),
    ).toEqual({ escalationLimits: { maxExtensions: 0 } });
  });
});
