/**
 * #1366 (fence-config shard) — the retention option on its own, each rule over plain values: the defaults filled in
 * (the files as long as the tasks), what a retention may not be (not a positive finite duration, a century or more, at
 * or below the lease for the rows a fenced write relies on), the file retention above the task's, an option of before
 * #834 refused where it went, and the names the sweep reads.
 */
import { describe, expect, it } from "vitest";
import {
  assembledRetentionsOf,
  DEFAULT_RETENTION,
  isPlainObject,
  movedRetentionViolations,
  retentionOf,
  retentionViolations,
} from "../../src/application/retention.js";
import { hours, minutes, seconds } from "../../src/units/index.js";

const CODE = "application.retention-invalid";
const DEFAULT_HINT =
  "@Application({ retention: { pauseRecords: hours(24), auditLog: hours(24) } })";
const hint = (...fields: string[]): string =>
  `@Application({ retention: { ${fields.map((field) => `${field}: hours(24)`).join(", ")} } })`;
const messagesOf = (application: string, options: unknown): string[] =>
  retentionViolations(application, options).map((found) => found.message);

describe("#1366: the retentions with their defaults", () => {
  it("every one that is not given is its default; execution records are kept only when asked", () => {
    const out = retentionOf(undefined);

    expect(out).toEqual({ ...DEFAULT_RETENTION, a2aFiles: DEFAULT_RETENTION.a2aTasks });
    expect(Object.keys(out)).not.toContain("executionRecords");
  });

  it("each one given is the one used, and the files follow their task's unless given", () => {
    const given = {
      pauseRecords: hours(1),
      executionRecords: hours(2),
      auditLog: hours(3),
      costLedgerEntries: hours(4),
      a2aTasks: hours(8),
      a2aMessages: hours(9),
    };

    expect(retentionOf(given)).toEqual({ ...given, a2aFiles: hours(8) });
    expect(retentionOf({ a2aTasks: hours(8), a2aFiles: hours(2) }).a2aFiles).toBe(hours(2));
    expect(retentionOf({ a2aFiles: hours(2) }).a2aTasks).toBe(DEFAULT_RETENTION.a2aTasks);
    expect(retentionOf({ a2aFiles: hours(2) }).a2aMessages).toBe(minutes(15));
  });

  it("is read by the sweep under its own names, execution records only when kept", () => {
    const kept = assembledRetentionsOf(retentionOf({ executionRecords: hours(2) }));
    const none = assembledRetentionsOf(retentionOf(undefined));

    expect(kept).toEqual({
      pauseRecordRetention: DEFAULT_RETENTION.pauseRecords,
      executionRecordRetention: hours(2),
      auditLogRetention: DEFAULT_RETENTION.auditLog,
      a2aTaskRetention: DEFAULT_RETENTION.a2aTasks,
      a2aFileRetention: DEFAULT_RETENTION.a2aTasks,
      a2aMessageRetention: DEFAULT_RETENTION.a2aMessages,
      ledgerEntryRetention: DEFAULT_RETENTION.costLedgerEntries,
    });
    expect(Object.keys(none)).not.toContain("executionRecordRetention");
  });
});

describe("#1366: what a retention may not be", () => {
  it("nothing is wrong with none, or with positive durations above the lease", () => {
    expect(retentionViolations("app", undefined)).toEqual([]);
    expect(retentionViolations("app", {})).toEqual([]);
    expect(retentionViolations("app", { pauseRecords: hours(1), auditLog: seconds(1) })).toEqual(
      [],
    );
  });

  it("an option that is no object of retentions is refused, shown as it is", () => {
    expect(messagesOf("app", "a day")).toEqual([
      `its retention is "a day", not an object of retentions — ${DEFAULT_HINT}`,
    ]);
    expect(messagesOf("app", [])).toEqual([
      `its retention is an array, not an object of retentions — ${DEFAULT_HINT}`,
    ]);
    expect(messagesOf("app", new Map())).toEqual([
      `its retention is a Map, not an object of retentions — ${DEFAULT_HINT}`,
    ]);
    expect(retentionViolations("app", Object.create(null) as object)).toEqual([]);
  });

  it("is a violation of the application, with its code", () => {
    expect(retentionViolations("desk", { auditLog: 0 })).toEqual([
      expect.objectContaining({ code: CODE, nodes: ["desk"] }),
    ]);
  });

  it.each([
    ["zero", 0, "is 0, not a positive duration"],
    ["negative", -5, "is -5, not a positive duration"],
    ["not finite", Number.POSITIVE_INFINITY, "is Infinity, not a positive duration"],
    ["not a number", "day", 'is "day", not a positive duration'],
  ])(
    "a retention that is %s is refused, with the fix for that field only",
    (_why, value, problem) => {
      expect(messagesOf("app", { auditLog: value })).toEqual([
        `its retention.auditLog ${problem} — ${hint("auditLog")}`,
      ]);
    },
  );

  it("beyond a century is not a duration a cutoff can hold, and a century is", () => {
    const century = hours(24 * 365 * 100);

    expect(messagesOf("app", { auditLog: century + 1 })).toEqual([
      `its retention.auditLog is ${String(century + 1)} ms, above a century (${String(century)} ms) — a cutoff a date cannot hold — ${hint("auditLog")}`,
    ]);
    expect(retentionViolations("app", { auditLog: century })).toEqual([]);
  });

  it.each(["costLedgerEntries", "a2aMessages"])(
    "%s, which a fenced write relies on, is above the lease: 30 s is refused, one millisecond more is not",
    (field) => {
      expect(messagesOf("app", { [field]: seconds(30) })).toEqual([
        `its retention.${field} is 30000 ms, not above the lease's 30000 ms — ${hint(field)}`,
      ]);
      expect(retentionViolations("app", { [field]: seconds(30) + 1 })).toEqual([]);
    },
  );

  it("the others may be under the lease", () => {
    expect(retentionViolations("app", { pauseRecords: seconds(1), auditLog: seconds(1) })).toEqual(
      [],
    );
  });

  it("a field it does not know is a typo, a renamed one says where it went; every problem comes at once", () => {
    expect(
      messagesOf("app", { auditlog: hours(1), leaseEvents: hours(1), pauseRecords: -1 }),
    ).toEqual([
      `its retention.auditlog is not a retention (pauseRecords, executionRecords, auditLog, costLedgerEntries, a2aTasks, a2aFiles, a2aMessages) — ${DEFAULT_HINT}`,
      `its retention.leaseEvents is renamed: the audit log's rows are kept for retention.auditLog — ${DEFAULT_HINT}`,
      `its retention.pauseRecords is -1, not a positive duration — ${hint("pauseRecords")}`,
    ]);
  });
});

describe("#1366: the files of an A2A task", () => {
  it("are not kept longer than their task, as given or by default", () => {
    const fix = hint("a2aTasks", "a2aFiles");

    expect(messagesOf("app", { a2aTasks: hours(1), a2aFiles: hours(2) })).toEqual([
      `its retention.a2aFiles is 7200000 ms, above a2aTasks' 3600000 ms — a file outliving its task is read by no one — ${fix}`,
    ]);
    expect(messagesOf("app", { a2aFiles: hours(25) })).toEqual([
      `its retention.a2aFiles is 90000000 ms, above a2aTasks' 86400000 ms — a file outliving its task is read by no one — ${fix}`,
    ]);
  });

  it("as long as, or shorter than, their task's are fine, and so is a files retention that is no number (refused on its own)", () => {
    expect(retentionViolations("app", { a2aTasks: hours(2), a2aFiles: hours(2) })).toEqual([]);
    expect(retentionViolations("app", { a2aTasks: hours(2), a2aFiles: hours(1) })).toEqual([]);
    expect(retentionViolations("app", { a2aFiles: hours(1) })).toEqual([]);
    expect(messagesOf("app", { a2aFiles: "long" })).toHaveLength(1);
    expect(messagesOf("app", { a2aTasks: "long", a2aFiles: hours(99) }).join()).not.toContain(
      "outliving",
    );
  });
});

describe("#1366: an object of retentions", () => {
  it("is one made by a literal or with no prototype, never a value of another kind", () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    for (const other of [
      undefined,
      null,
      "a day",
      5,
      true,
      [],
      new Map(),
      () => 1,
      new (class Own {
        readonly own = true;
      })(),
    ])
      expect(isPlainObject(other)).toBe(false);
  });

  it("a field named like a member of every object is a typo, not a renamed field", () => {
    expect(messagesOf("app", { toString: hours(1) })).toEqual([
      expect.stringContaining("its retention.toString is not a retention ("),
    ]);
  });
});

describe("#1366: an option of before #834", () => {
  it("is refused naming where it is now, for every one that moved", () => {
    const moved = {
      pauseRecordRetention: hours(1),
      executionRecordRetention: hours(1),
      leaseEventRetention: hours(1),
      ledgerEntryRetention: hours(1),
      a2a: { taskRetention: hours(1) },
    };

    const found = movedRetentionViolations("desk", moved);

    expect(found.map((item) => item.message)).toEqual([
      "its pauseRecordRetention is gone — @Application({ retention: { pauseRecords } }) sets it now",
      "its executionRecordRetention is gone — @Application({ retention: { executionRecords } }) sets it now",
      "its leaseEventRetention is gone — @Application({ retention: { auditLog } }) sets it now",
      "its ledgerEntryRetention is gone — @Application({ retention: { costLedgerEntries } }) sets it now",
      "its a2a.taskRetention is gone — @Application({ retention: { a2aTasks } }) sets it now",
    ]);
    expect(found.every((item) => item.code === CODE && item.nodes[0] === "desk")).toBe(true);
  });

  it("an option that never held a retention, or holds none of those, is no violation", () => {
    expect(movedRetentionViolations("desk", {})).toEqual([]);
    expect(
      movedRetentionViolations("desk", { pauseRecords: { backend: "x" }, mesh: "on" }),
    ).toEqual([]);
    expect(movedRetentionViolations("desk", { pauseRecords: null, costLedgerEntries: 4 })).toEqual(
      [],
    );
  });

  it("an a2a option without its retention is gone too, whatever it is; with it, it is only the retention that moved", () => {
    const gone =
      "its a2a option is gone — how long A2A tasks are kept is @Application({ retention: { a2aTasks } })";

    expect(movedRetentionViolations("desk", { a2a: {} }).map((item) => item.message)).toEqual([
      gone,
    ]);
    expect(movedRetentionViolations("desk", { a2a: {} })[0]?.nodes).toEqual(["desk"]);
    expect(movedRetentionViolations("desk", { a2a: "on" }).map((item) => item.message)).toEqual([
      gone,
    ]);
    expect(movedRetentionViolations("desk", { a2a: null }).map((item) => item.message)).toEqual([
      gone,
    ]);
    expect(
      movedRetentionViolations("desk", { a2a: { taskRetention: 1 } }).map((item) => item.message),
    ).toEqual([
      "its a2a.taskRetention is gone — @Application({ retention: { a2aTasks } }) sets it now",
    ]);
    expect(movedRetentionViolations("desk", {})).toEqual([]);
  });
});
