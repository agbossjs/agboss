/**
 * #633 (undo shard) — what one visit does to the undoable actions (`entriesOfVisit`) on its own: an
 * undoable action opens an entry with what its undo reads (a branch's own value under its variant's
 * slot), its next place in the tree's order, its committer; an undo action closes the newest open
 * entry it undoes; a committer commits what it commits — not when it failed, never the entry it
 * closed —; a finish commits what has no committer; the registry mirrors what was written.
 */
import { describe, expect, it, vi } from "vitest";
import { Text } from "../../../src/dto/index.js";
import { Action } from "../../../src/index.js";
import { NodeKind } from "../../../src/flow/ast.js";
import {
  CompensationEntryStatus,
  CompensationReason,
  CompensationStatus,
  type CompensationEntry,
  type VisitCompensationSite,
} from "../../../src/flow/compensation.js";
import { slotOfDto } from "../../../src/flow/analyse/scope.js";
import { entriesOfVisit } from "../../../src/flow/runtime/compensation/visit-entries.js";
import { bareRecordOf, ComponentKind } from "../../../src/flow/runtime/records.js";
import { entryOf } from "./fixtures/compensation-entries.js";

class BookingDto {
  @Text({ prompt: "the booking" })
  bookingId!: string;
}

class WaitlistDto {
  @Text({ prompt: "the waitlist place" })
  placeId!: string;
}

class GuestDto {
  @Text({ prompt: "the guest" })
  name!: string;
}

@Action({
  name: "cancel-booking-action",
  description: "Cancels",
  input: { booking: BookingDto, guest: GuestDto },
})
class CancelBookingAction {
  execute(): Promise<void> {
    return Promise.resolve();
  }
}

@Action({ name: "confirm-booking-action", description: "Confirms", input: {} })
class ConfirmBookingAction {
  execute(): Promise<void> {
    return Promise.resolve();
  }
}

@Action({
  name: "book-action",
  description: "Books",
  input: {},
  output: BookingDto,
  compensateWith: CancelBookingAction,
  committedBy: ConfirmBookingAction,
})
class BookAction {
  execute(): Promise<BookingDto> {
    return Promise.resolve({ bookingId: "b-1" });
  }
}

@Action({ name: "plain-action", description: "Nothing to undo", input: {} })
class PlainAction {
  execute(): Promise<void> {
    return Promise.resolve();
  }
}

const BOOKING_SLOT = slotOfDto(BookingDto);
const GUEST_SLOT = slotOfDto(GuestDto);
const WAITLIST_SLOT = slotOfDto(WaitlistDto);

const stepOf = (nodeId: string) => ({
  component: { type: Object, ...bareRecordOf(nodeId, ComponentKind.Action) },
  nodeId,
  visitNumber: 2,
  idempotencyKey: `root-1:${nodeId}:2`,
  callId: undefined,
  itemIndex: undefined,
  copyNumber: 1,
  toolLoopIteration: undefined,
  validationAttempts: 0,
});

const record = (slot: string, value: unknown, producer = "book-action") => ({
  valueId: `${producer}:2/${slot}`,
  slot,
  producer,
  value,
  builtFrom: [],
});

function siteOf(
  nodeId: string,
  component: unknown,
  overrides: Partial<VisitCompensationSite> = {},
): VisitCompensationSite {
  return {
    node: { id: nodeId, kind: NodeKind.Action, component } as never,
    entries: [],
    frame: {
      step: stepOf(nodeId),
      execution: { executionId: "root-1", tenant: { tenantId: "acme" } },
    } as never,
    scope: { [GUEST_SLOT]: record(GUEST_SLOT, { name: "ada" }, "start") },
    startedAt: new Date("2026-10-20T12:00:00.000Z"),
    endedAt: new Date("2026-10-20T12:00:01.000Z"),
    ...overrides,
  };
}

describe("#633: an undoable action's visit opens an entry", () => {
  it("its step, its undo and committer, what its undo reads, after the newest it knows", () => {
    const scope = {
      [GUEST_SLOT]: record(GUEST_SLOT, { name: "ada" }, "start"),
      [BOOKING_SLOT]: record(BOOKING_SLOT, { bookingId: "b-1" }),
      unread: record("UnreadDto", {}),
    };
    const entries = [entryOf("older", { sequence: 3 })];

    const [opened] = entriesOfVisit(siteOf("book-action", BookAction, { scope, entries }));

    expect(opened).toStrictEqual({
      key: "root-1:book-action:2",
      executionId: "root-1",
      sequence: 4,
      action: "book-action",
      compensated: expect.objectContaining({ nodeId: "book-action", visitNumber: 2 }) as never,
      compensator: "cancel-booking-action",
      committer: "confirm-booking-action",
      input: { [GUEST_SLOT]: scope[GUEST_SLOT], [BOOKING_SLOT]: scope[BOOKING_SLOT] },
      status: CompensationEntryStatus.Open,
    });
  });

  it("a slot its undo reads that the scope lacks: not in its snapshot", () => {
    const [opened] = entriesOfVisit(siteOf("book-action", BookAction, { scope: {} }));

    expect(opened?.input).toStrictEqual({});
  });

  it("the registry gives its place in the tree's order, and mirrors the entry", () => {
    const registry = { nextSequence: vi.fn(() => 9), write: vi.fn() };
    const parts = { timeout: 1, registry } as never;

    const written = entriesOfVisit(siteOf("book-action", BookAction, { parts }));

    expect(written.map((entry) => entry.sequence)).toEqual([9]);
    expect(registry.nextSequence).toHaveBeenCalledWith(
      { tenantId: "acme", rootExecutionId: "root-1" },
      0,
    );
    expect(registry.write).toHaveBeenCalledWith(
      { tenantId: "acme", rootExecutionId: "root-1" },
      written,
    );
  });

  it("an action that failed, one without an undo, a node of no action: no entry, nothing mirrored", () => {
    const registry = { nextSequence: vi.fn(() => 1), write: vi.fn() };
    const parts = { timeout: 1, registry } as never;

    const failed = entriesOfVisit(
      siteOf("book-action", BookAction, { parts, failure: new Error("declined") }),
    );
    const plain = entriesOfVisit(siteOf("plain-action", PlainAction, { parts }));
    const other = entriesOfVisit(siteOf("other-node", Object, { parts }));

    expect([failed, plain, other]).toEqual([[], [], []]);
    expect(registry.write).not.toHaveBeenCalled();
  });

  it("no committer declared: none on the entry", () => {
    @Action({
      name: "hold-action",
      description: "Holds",
      input: {},
      output: BookingDto,
      compensateWith: CancelBookingAction,
    })
    class HoldAction {
      execute(): Promise<BookingDto> {
        return Promise.resolve({ bookingId: "h-1" });
      }
    }

    const [opened] = entriesOfVisit(siteOf("hold-action", HoldAction));

    expect(opened).not.toHaveProperty("committer");
    expect(opened).not.toHaveProperty("launchId");
  });
});

describe("#633: a branch's entry reads the branch's own value", () => {
  const dtos = new Map<string, never>([["waitlist", WaitlistDto as never]]);

  it("its output's slot, built from nothing, with no variant", () => {
    const branch = { launchId: "launch-1", value: { value: { bookingId: "b-2" } }, dtos };

    const [opened] = entriesOfVisit(siteOf("book-action", BookAction, { branch }));

    expect(opened?.launchId).toBe("launch-1");
    expect(opened?.input[BOOKING_SLOT]).toStrictEqual({
      valueId: `book-action:2/${BOOKING_SLOT}`,
      slot: BOOKING_SLOT,
      producer: "book-action",
      value: { bookingId: "b-2" },
      builtFrom: [],
    });
  });

  it("a variant: under its own class's slot, with the variant", () => {
    @Action({
      name: "unwait-action",
      description: "Leaves the waitlist",
      input: { place: WaitlistDto },
    })
    class UnwaitAction {
      execute(): Promise<void> {
        return Promise.resolve();
      }
    }
    @Action({
      name: "wait-action",
      description: "Books or waitlists",
      input: {},
      output: BookingDto,
      compensateWith: UnwaitAction,
    })
    class WaitAction {
      execute(): Promise<BookingDto> {
        return Promise.resolve({ bookingId: "w-1" });
      }
    }
    const value = { variant: "waitlist", value: { placeId: "p-1" } };
    const branch = { launchId: "launch-1", value, dtos };

    const [opened] = entriesOfVisit(siteOf("wait-action", WaitAction, { branch }));

    expect(opened?.input).toStrictEqual({
      [WAITLIST_SLOT]: {
        valueId: `wait-action:2/${WAITLIST_SLOT}`,
        slot: WAITLIST_SLOT,
        producer: "wait-action",
        value: { placeId: "p-1" },
        variant: "waitlist",
        builtFrom: [],
      },
    });
  });

  it("a variant its launch does not know, or no value: the scope as it is", () => {
    const unknown = { launchId: "launch-1", value: { variant: "gone", value: {} }, dtos };
    const none = { launchId: "launch-1", value: undefined, dtos };

    for (const branch of [unknown, none]) {
      const [opened] = entriesOfVisit(siteOf("book-action", BookAction, { branch }));

      expect(Object.keys(opened?.input ?? {})).toEqual([GUEST_SLOT]);
    }
  });
});

describe("#633: an undo action's visit closes the newest open entry it undoes", () => {
  const room = (key: string, sequence: number, status = CompensationEntryStatus.Open) =>
    entryOf(key, { sequence, status, compensator: "cancel-booking-action" });

  it("by the tree's order, never a closed one; its record a side path's", () => {
    const entries = [
      room("new", 3),
      room("old", 1),
      room("mid", 2),
      room("gone", 4, CompensationEntryStatus.Closed),
    ];

    const [closed] = entriesOfVisit(
      siteOf("cancel-booking-action", CancelBookingAction, { entries }),
    );

    expect(closed?.key).toBe("new");
    expect(closed?.status).toBe(CompensationEntryStatus.Closed);
    expect(closed?.undo).toMatchObject({
      reason: CompensationReason.SidePath,
      status: CompensationStatus.Compensated,
      startedAt: "2026-10-20T12:00:00.000Z",
      endedAt: "2026-10-20T12:00:01.000Z",
    });
    expect(closed?.undo).not.toHaveProperty("error");
  });

  it("an undo whose own .onError took its failure: closed Failed with the error, nothing committed", () => {
    const entries = [
      room("room", 1),
      entryOf("seat", { sequence: 2, committer: "cancel-booking-action" }),
    ];

    const written = entriesOfVisit(
      siteOf("cancel-booking-action", CancelBookingAction, {
        entries,
        failure: new Error("desk down"),
      }),
    );

    expect(written.map((entry) => entry.key)).toEqual(["room"]);
    expect(written[0]?.undo).toMatchObject({
      status: CompensationStatus.Failed,
      error: { message: "desk down" },
    });
  });
});

describe("#633: commits", () => {
  it("a committer commits its open entries — never the one it closed as their undo too", () => {
    const entries: CompensationEntry[] = [
      entryOf("both", {
        sequence: 2,
        compensator: "confirm-booking-action",
        committer: "confirm-booking-action",
      }),
      entryOf("mine", { sequence: 1, committer: "confirm-booking-action" }),
      entryOf("theirs", { sequence: 3, committer: "other-action" }),
      entryOf("done", {
        sequence: 4,
        committer: "confirm-booking-action",
        status: CompensationEntryStatus.Closed,
      }),
    ];

    const written = entriesOfVisit(
      siteOf("confirm-booking-action", ConfirmBookingAction, { entries }),
    );

    expect(written.map((entry) => [entry.key, entry.status])).toEqual([
      ["both", CompensationEntryStatus.Closed],
      ["mine", CompensationEntryStatus.Committed],
    ]);
  });

  it("a finish commits the open entries no committer commits, in the tree's order", () => {
    const entries = [
      entryOf("second", { sequence: 2 }),
      entryOf("first", { sequence: 1 }),
      entryOf("committed-later", { sequence: 3, committer: "confirm-booking-action" }),
      entryOf("closed", { sequence: 4, status: CompensationEntryStatus.Closed }),
    ];
    const site = siteOf("done-finish", undefined, { entries });

    const written = entriesOfVisit({ ...site, node: { ...site.node, kind: NodeKind.Finish } });

    expect(written.map((entry) => [entry.key, entry.status])).toEqual([
      ["first", CompensationEntryStatus.Committed],
      ["second", CompensationEntryStatus.Committed],
    ]);
  });
});
