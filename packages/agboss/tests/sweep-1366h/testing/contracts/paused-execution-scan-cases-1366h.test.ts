/**
 * #1366: the paused-execution contract's scan and keyset cases (`paused-execution-scan.cases.ts`,
 * `paused-execution-keyset.cases.ts`) judge a store by what it returns: each passes on a correct
 * store and FAILS (with an assertion, never a crash or a runaway loop) on a store that breaks the
 * rule the case names; a few pin that the case asks with real ids, no recipients and the page's
 * last pause as the keyset.
 */
import { describe, expect, it } from "vitest";
import { InMemoryPausedExecutionRepository } from "../../../../src/infrastructure/in-memory-paused-execution.repository.js";
import type { PauseScanAfter } from "../../../../src/infrastructure/pause-notices.js";
import {
  PauseStatus,
  type PausedExecutionRepository,
  type PauseRecord,
} from "../../../../src/infrastructure/paused-execution.repository.js";

type PausePage = Awaited<ReturnType<PausedExecutionRepository["findOpenAfter"]>>;
import { VirtualClock } from "../../../../src/testing/clock.js";
import type { ContractCase } from "../../../../src/testing/contracts/define.js";
import { KEYSET_CASES } from "../../../../src/testing/contracts/paused-execution-keyset.cases.js";
import { SCAN_CASES } from "../../../../src/testing/contracts/paused-execution-scan.cases.js";

type Column = "expiresAt" | "remindAt";
type Case = ContractCase<PausedExecutionRepository>;
type Filter = Parameters<PausedExecutionRepository["findPageByTenantId"]>[1];

interface Tweaks {
  /** Skips the limit's range check on every scan. */
  readonly noLimitCheck?: boolean;
  /** A scan that reads `limit + 2` pauses (a page longer than asked). */
  readonly oversize?: boolean;
  /** Drops the `after` keyset (every page is the first). */
  readonly ignoreAfter?: boolean;
  /** Drops the `after` keyset except past the last pause, which is nothing. */
  readonly stuck?: boolean;
  /** A scan consistently without this pause (`tenant/id`). */
  readonly drop?: string;
  /** A keyset with an empty tenant reads nothing. */
  readonly emptyTenantNothing?: boolean;
  /** A keyset with an empty tenant reads from the first pause. */
  readonly emptyTenantRestarts?: boolean;
  /** A keyset with an empty tenant is read as `at` only, ties dropped. */
  readonly emptyTenantStrict?: boolean;
  /** A page behind a keyset comes back with this change. */
  readonly changeAfterPage?: (pause: PauseRecord, column: Column, isLast: boolean) => PauseRecord;
  /** Strings compared by locale (as a database collation does); ties ordered by id before tenant. */
  readonly locale?: boolean;
  readonly idFirst?: boolean;
}

const callBudget = 60;
const keyOf = (pause: PauseRecord, tweaks: Tweaks, column: Column): string[] => {
  const parts = [pause[column]?.toISOString() ?? "", pause.tenantId, pause.pauseId];
  return tweaks.idFirst === true ? [parts[0] ?? "", parts[2] ?? "", parts[1] ?? ""] : parts;
};
const compareText = (a: string, b: string, tweaks: Tweaks): number =>
  tweaks.locale === true ? a.localeCompare(b) : a < b ? -1 : a > b ? 1 : 0;
const compareKeys = (a: readonly string[], b: readonly string[], tweaks: Tweaks): number => {
  for (const [index, part] of a.entries()) {
    const order = compareText(part, b[index] ?? "", tweaks);
    if (order !== 0) return order;
  }
  return 0;
};

const isLastOf = (
  sorted: readonly PauseRecord[],
  column: Column,
  keyset: PauseScanAfter,
): boolean => {
  const last = sorted.at(-1);
  return (
    last?.[column]?.getTime() === keyset.at.getTime() &&
    last.tenantId === keyset.tenantId &&
    last.pauseId === keyset.pauseId
  );
};

/** The in-memory store with the scans of #1070 rewritten so each can be broken one way. */
class TweakedStore extends InMemoryPausedExecutionRepository {
  readonly #tweaks: Tweaks;
  /** The scans made: a loop that never ends is stopped here, with an error that is no assertion. */
  calls = 0;

  constructor(tweaks: Tweaks = {}) {
    super();
    this.#tweaks = tweaks;
  }

  override async findPendingByExpiresAtBefore(
    at: Date,
    limit: number,
    after?: PauseScanAfter,
  ): Promise<readonly PauseRecord[]> {
    if (this.#tweaks.noLimitCheck !== true) await super.findPendingByExpiresAtBefore(at, limit);
    return this.#scan(
      "expiresAt",
      await super.findPendingByExpiresAtBefore(at, 1000),
      limit,
      after,
    );
  }

  override async findPendingByRemindAtBefore(
    at: Date,
    limit: number,
    after?: PauseScanAfter,
  ): Promise<readonly PauseRecord[]> {
    if (this.#tweaks.noLimitCheck !== true) await super.findPendingByRemindAtBefore(at, limit);
    return this.#scan("remindAt", await super.findPendingByRemindAtBefore(at, 1000), limit, after);
  }

  override findOpenAfter(after: string | undefined, limit: number): Promise<PausePage> {
    return super.findOpenAfter(after, this.#tweaks.noLimitCheck === true ? 5 : limit);
  }

  override findClosedByResolvedAtBefore(
    cutoff: Date,
    limit: number,
    after?: string,
  ): Promise<PausePage> {
    return super.findClosedByResolvedAtBefore(
      cutoff,
      this.#tweaks.noLimitCheck === true ? 5 : limit,
      after,
    );
  }

  #scan(
    column: Column,
    all: readonly PauseRecord[],
    limit: number,
    keyset: PauseScanAfter | undefined,
  ): readonly PauseRecord[] {
    const tweaks = this.#tweaks;
    this.calls += 1;
    if (this.calls > callBudget) {
      throw new Error("runaway: a scan loop that does not end");
    }
    const sorted = [...all]
      .filter((pause) => `${pause.tenantId}/${pause.pauseId}` !== tweaks.drop)
      .sort((a, b) => compareKeys(keyOf(a, tweaks, column), keyOf(b, tweaks, column), tweaks));
    const after = this.#effectiveAfter(sorted, column, keyset);
    if (after === "nothing") return [];
    const past = sorted.filter((pause) => {
      if (after === undefined) return true;
      if (tweaks.emptyTenantStrict === true && after.tenantId === "") {
        return (pause[column]?.toISOString() ?? "") > after.at.toISOString();
      }
      const bound =
        tweaks.idFirst === true
          ? [after.at.toISOString(), after.pauseId, after.tenantId]
          : [after.at.toISOString(), after.tenantId, after.pauseId];
      return compareKeys(keyOf(pause, tweaks, column), bound, tweaks) > 0;
    });
    const page = past.slice(0, tweaks.oversize === true ? limit + 2 : limit);
    return after === undefined || tweaks.changeAfterPage === undefined
      ? page
      : page.map(
          (pause, index) =>
            tweaks.changeAfterPage?.(pause, column, index === page.length - 1) ?? pause,
        );
  }

  #effectiveAfter(
    sorted: readonly PauseRecord[],
    column: Column,
    keyset: PauseScanAfter | undefined,
  ): PauseScanAfter | undefined | "nothing" {
    const tweaks = this.#tweaks;
    if (keyset === undefined || tweaks.ignoreAfter === true) return undefined;
    if (keyset.tenantId === "") {
      if (tweaks.emptyTenantNothing === true) return "nothing";
      if (tweaks.emptyTenantRestarts === true) return undefined;
    }
    return tweaks.stuck === true && !isLastOf(sorted, column, keyset) ? undefined : keyset;
  }
}

/** Bodies of the store's other calls broken one way each. */
interface PageTweaks {
  readonly nextOnLastAfter?: boolean;
  readonly nextOnFirst?: boolean;
  readonly resolvedNotOpen?: boolean;
  readonly statusesOptional?: boolean;
  readonly emptyChannelMatchesAny?: boolean;
  readonly emptyTenantMatchesAny?: boolean;
  readonly offsetCursor?: boolean;
  readonly deleteIgnoresRun?: boolean;
  readonly emptyRunDeletesAll?: boolean;
  readonly deleteNothing?: boolean;
  readonly strictArguments?: boolean;
}

const ALL_STATUSES = [
  PauseStatus.Pending,
  PauseStatus.Resolved,
  PauseStatus.Taken,
  PauseStatus.Cancelled,
];

class PagedStore extends TweakedStore {
  readonly #page: PageTweaks;

  constructor(page: PageTweaks) {
    super();
    this.#page = page;
  }

  #strict(...values: readonly string[]): void {
    if (this.#page.strictArguments === true && values.includes("")) {
      throw new RangeError("an id is empty");
    }
  }

  override async findOpenAfter(after: string | undefined, limit: number): Promise<PausePage> {
    const page = await super.findOpenAfter(after, limit);
    const open =
      this.#page.resolvedNotOpen === true
        ? { ...page, pauses: page.pauses.filter((pause) => pause.status !== PauseStatus.Resolved) }
        : page;
    const isLast = open.next === undefined;
    if (this.#page.nextOnFirst === true && after === undefined && isLast)
      return { ...open, next: "end" };
    if (this.#page.nextOnLastAfter === true && after !== undefined && isLast)
      return { ...open, next: "end" };
    return open;
  }

  override async findPageByTenantId(
    tenantId: string,
    filter: Filter,
    limit: number,
    after?: string,
  ): Promise<PausePage> {
    const tweaks = this.#page;
    if (
      tweaks.statusesOptional === true &&
      (filter as { statuses?: unknown }).statuses === undefined
    ) {
      return super.findPageByTenantId(
        tenantId,
        { ...filter, statuses: ALL_STATUSES },
        limit,
        after,
      );
    }
    if (tweaks.emptyChannelMatchesAny === true && filter.target !== undefined) {
      return this.#pageOfAnyEmptyChannel(tenantId, filter, limit);
    }
    if (tweaks.emptyTenantMatchesAny === true) {
      const own = await super.findPageByTenantId(tenantId, filter, limit, after);
      const empty = await super.findPageByTenantId("", filter, 1000);
      return { ...own, pauses: [...own.pauses, ...empty.pauses].slice(0, limit) };
    }
    if (tweaks.offsetCursor === true) return this.#pageByOffset(tenantId, filter, limit, after);
    const page = await super.findPageByTenantId(tenantId, filter, limit, after);
    return tweaks.nextOnLastAfter === true && after !== undefined && page.next === undefined
      ? { ...page, next: "end" }
      : page;
  }

  async #pageOfAnyEmptyChannel(
    tenantId: string,
    filter: Filter,
    limit: number,
  ): Promise<PausePage> {
    const { target, ...rest } = filter;
    const all = await super.findPageByTenantId(tenantId, rest, 1000);
    return {
      pauses: all.pauses
        .filter((pause) => !pause.target || pause.target === target)
        .slice(0, limit),
    };
  }

  async #pageByOffset(
    tenantId: string,
    filter: Filter,
    limit: number,
    after?: string,
  ): Promise<PausePage> {
    const all = (await super.findPageByTenantId(tenantId, filter, 1000)).pauses;
    const start = after === undefined ? 0 : Number(after);
    const pauses = all.slice(start, start + limit);
    return start + limit < all.length ? { pauses, next: String(start + limit) } : { pauses };
  }

  override async deleteByTenantIdAndThreadIdAndRunId(
    tenantId: string,
    threadId: string,
    runId: string,
  ): Promise<void> {
    this.#strict(tenantId, threadId, runId);
    const tweaks = this.#page;
    if (tweaks.deleteNothing === true) return;
    if (tweaks.deleteIgnoresRun === true || (tweaks.emptyRunDeletesAll === true && runId === "")) {
      await super.deleteByTenantIdAndThreadId(tenantId, threadId);
      return;
    }
    await super.deleteByTenantIdAndThreadIdAndRunId(tenantId, threadId, runId);
  }

  override async resolveByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    ...rest: Parameters<PausedExecutionRepository["resolveByTenantIdAndPauseId"]> extends [
      string,
      string,
      ...infer R,
    ]
      ? R
      : never
  ): Promise<PauseRecord | undefined> {
    this.#strict(tenantId, pauseId);
    this.#noRecipients(rest[2]);
    return super.resolveByTenantIdAndPauseId(tenantId, pauseId, ...rest);
  }

  override async cancelByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    ...rest: Parameters<PausedExecutionRepository["cancelByTenantIdAndPauseId"]> extends [
      string,
      string,
      ...infer R,
    ]
      ? R
      : never
  ): Promise<PauseRecord | undefined> {
    this.#strict(tenantId, pauseId);
    this.#noRecipients(rest[2]);
    return super.cancelByTenantIdAndPauseId(tenantId, pauseId, ...rest);
  }

  override decideByTenantIdAndPauseId(
    tenantId: string,
    pauseId: string,
    ...rest: Parameters<PausedExecutionRepository["decideByTenantIdAndPauseId"]> extends [
      string,
      string,
      ...infer R,
    ]
      ? R
      : never
  ): Promise<boolean> {
    this.#strict(tenantId, pauseId);
    return super.decideByTenantIdAndPauseId(tenantId, pauseId, ...rest);
  }

  #noRecipients(recipients: { readonly listeners?: readonly unknown[] }): void {
    if (this.#page.strictArguments === true && recipients.listeners?.length !== 0) {
      throw new RangeError("the case names recipients");
    }
  }
}

const caseNamed = (cases: readonly Case[], start: string): Case => {
  const found = cases.find((candidate) => candidate.name.startsWith(start));
  if (found === undefined) throw new Error(`no case starts with ${start}`);
  return found;
};

/** How a case ends on a store: "pass", the name of the error it failed with. */
async function outcomeOf(contractCase: Case, store: PausedExecutionRepository): Promise<string> {
  try {
    await contractCase.run({ clock: new VirtualClock(), first: store, second: store });
    return "pass";
  } catch (error) {
    return error instanceof Error ? error.name : "unknown";
  }
}

const EXPIRES = caseNamed(KEYSET_CASES, "#1070: findPendingByExpiresAtBefore after a keyset");
const REMIND = caseNamed(KEYSET_CASES, "#942: findPendingByRemindAtBefore after a keyset");
const TIED_EXPIRES = caseNamed(KEYSET_CASES, "#1070: due pauses of one tenant");
const TIED_REMIND = caseNamed(KEYSET_CASES, "#942: due pauses of one tenant");
const KEYSET = [EXPIRES, REMIND, TIED_EXPIRES, TIED_REMIND];

/** The time of a pause that is not the page's last (the last one's is the next keyset) is wrong. */
const shift = (pause: PauseRecord, column: Column, isLast: boolean): PauseRecord =>
  isLast ? pause : { ...pause, [column]: new Date("2026-01-05T10:00:00.000Z") };
const renamed = (pause: PauseRecord): PauseRecord => ({ ...pause, pauseId: `${pause.pauseId}x` });

describe("#1366: the keyset cases pass a correct store", () => {
  it.each(KEYSET.map((contractCase) => [contractCase.name, contractCase] as const))(
    "%s",
    async (_, contractCase) => {
      expect(await outcomeOf(contractCase, new TweakedStore())).toBe("pass");
    },
  );
  it("also on a store with a locale collation and a page longer than asked", async () => {
    for (const contractCase of KEYSET) {
      expect(await outcomeOf(contractCase, new TweakedStore({ locale: true }))).toBe("pass");
      expect(await outcomeOf(contractCase, new TweakedStore({ oversize: true }))).toBe("pass");
    }
    for (const contractCase of [EXPIRES, REMIND]) {
      expect(await outcomeOf(contractCase, new TweakedStore({ locale: true, idFirst: true }))).toBe(
        "pass",
      );
    }
  });
});

describe("#1366: a store that breaks the keyset fails the cases with an assertion", () => {
  it("a keyset that is ignored never ends the paging in a runaway: the case stops it and fails", async () => {
    for (const contractCase of KEYSET) {
      const store = new TweakedStore({ ignoreAfter: true });
      expect(await outcomeOf(contractCase, store)).toBe("AssertionError");
      expect(store.calls).toBeLessThan(callBudget);
    }
  });

  it("a scan without one pause reads fewer than the five due ones", async () => {
    expect(await outcomeOf(EXPIRES, new TweakedStore({ drop: "acme/p3" }))).toBe("AssertionError");
    expect(await outcomeOf(REMIND, new TweakedStore({ drop: "acme/p3" }))).toBe("AssertionError");
  });

  it("pages that differ from the whole scan fail even when the keyset past the last is empty and the keyset before the first reads all", async () => {
    expect(await outcomeOf(EXPIRES, new TweakedStore({ stuck: true }))).toBe("AssertionError");
    expect(await outcomeOf(REMIND, new TweakedStore({ stuck: true }))).toBe("AssertionError");
  });

  it("a keyset with an empty tenant that reads nothing fails the keyset before the first pause", async () => {
    expect(await outcomeOf(EXPIRES, new TweakedStore({ emptyTenantNothing: true }))).toBe(
      "AssertionError",
    );
    expect(await outcomeOf(REMIND, new TweakedStore({ emptyTenantNothing: true }))).toBe(
      "AssertionError",
    );
  });

  it("a keyset with an empty tenant that drops the ties at its time fails the keyset before the first pause", async () => {
    expect(await outcomeOf(EXPIRES, new TweakedStore({ emptyTenantStrict: true }))).toBe(
      "AssertionError",
    );
    expect(await outcomeOf(REMIND, new TweakedStore({ emptyTenantStrict: true }))).toBe(
      "AssertionError",
    );
  });

  it("a keyset with an empty tenant that restarts the scan passes the tied cases: their pauses keep a tenant", async () => {
    for (const contractCase of [TIED_EXPIRES, TIED_REMIND]) {
      expect(await outcomeOf(contractCase, new TweakedStore({ emptyTenantRestarts: true }))).toBe(
        "pass",
      );
    }
  });

  it("pages whose deadline, reminder or id differ from the whole scan's fail the case", async () => {
    expect(await outcomeOf(EXPIRES, new TweakedStore({ changeAfterPage: shift }))).toBe(
      "AssertionError",
    );
    expect(await outcomeOf(REMIND, new TweakedStore({ changeAfterPage: shift }))).toBe(
      "AssertionError",
    );
    expect(await outcomeOf(EXPIRES, new TweakedStore({ changeAfterPage: renamed }))).toBe(
      "AssertionError",
    );
    expect(await outcomeOf(REMIND, new TweakedStore({ changeAfterPage: renamed }))).toBe(
      "AssertionError",
    );
  });
});

const SCAN = caseNamed(SCAN_CASES, "findPendingByExpiresAtBefore: every tenant");
const LIMIT = caseNamed(SCAN_CASES, "a limit outside 1–1000");
const OPEN = caseNamed(SCAN_CASES, "findOpenAfter pages Pending and Resolved");
const PAGE = caseNamed(SCAN_CASES, "findPageByTenantId filters status");
const REMOVED = caseNamed(SCAN_CASES, "records removed between two pages");
const DELETE = caseNamed(SCAN_CASES, "deleteByTenantIdAndThreadIdAndRunId removes");
const SCAN_ALL = [SCAN, LIMIT, OPEN, PAGE, REMOVED, DELETE];

describe("#1366: the scan cases pass a correct store", () => {
  it.each(SCAN_ALL.map((contractCase) => [contractCase.name, contractCase] as const))(
    "%s",
    async (_, contractCase) => {
      expect(await outcomeOf(contractCase, new PagedStore({}))).toBe("pass");
      expect(await outcomeOf(contractCase, new PagedStore({ strictArguments: true }))).toBe("pass");
    },
  );
  it("a store that makes the statuses optional but rejects an empty list passes: the case asks with an empty list, not a missing one", async () => {
    expect(await outcomeOf(PAGE, new PagedStore({ statusesOptional: true }))).toBe("pass");
  });
  it("a store that reads an empty channel or an empty tenant as 'any' passes: the case's pauses have a channel and a tenant", async () => {
    expect(await outcomeOf(PAGE, new PagedStore({ emptyChannelMatchesAny: true }))).toBe("pass");
    expect(await outcomeOf(PAGE, new PagedStore({ emptyTenantMatchesAny: true }))).toBe("pass");
  });
  it("a store that reads an empty run id as 'every run' passes: the case deletes a named run", async () => {
    expect(await outcomeOf(DELETE, new PagedStore({ emptyRunDeletesAll: true }))).toBe("pass");
  });
});

describe("#1366: a store that breaks a scan rule fails its case with an assertion", () => {
  it("a limit that is not range-checked", async () => {
    expect(await outcomeOf(LIMIT, new TweakedStore({ noLimitCheck: true }))).toBe("AssertionError");
  });

  it("a Resolved pause that is not open is missing from the orphan look", async () => {
    expect(await outcomeOf(OPEN, new PagedStore({ resolvedNotOpen: true }))).toBe("AssertionError");
  });

  it("a cursor on the last page: the orphan look and the tenant's page end with none", async () => {
    expect(await outcomeOf(OPEN, new PagedStore({ nextOnLastAfter: true }))).toBe("AssertionError");
    expect(await outcomeOf(PAGE, new PagedStore({ nextOnLastAfter: true }))).toBe("AssertionError");
  });

  it("a cursor on a read of the whole backlog: the orphan look ends with none", async () => {
    expect(await outcomeOf(OPEN, new PagedStore({ nextOnFirst: true }))).toBe("AssertionError");
  });

  it("a tenant's page whose cursor is a position fails when records are removed between two pages", async () => {
    expect(await outcomeOf(REMOVED, new PagedStore({ offsetCursor: true }))).toBe("AssertionError");
  });

  it("a delete of one run that takes the thread's other runs fails with an assertion, not a crash", async () => {
    expect(await outcomeOf(DELETE, new PagedStore({ deleteIgnoresRun: true }))).toBe(
      "AssertionError",
    );
  });

  it("a delete that removes nothing fails the case at the final look", async () => {
    expect(await outcomeOf(DELETE, new PagedStore({ deleteNothing: true }))).toBe("AssertionError");
  });
});
