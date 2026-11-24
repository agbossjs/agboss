/**
 * #1366: the direct-message sweep contract cases fail on a store that breaks the rule each case
 * checks (one broken way per rule) and pass on the sound in-memory one: what the sweep removes, in
 * what order, how many, which claims it frees, and which expired attempts are found.
 */
import { describe, expect, it } from "vitest";
import {
  A2ADirectMessageSaveStatus,
  A2ADirectMessageState,
  type A2ADirectMessageRecord,
} from "../../../../src/infrastructure/a2a-direct-message.repository.js";
import { A2ATaskSaveStatus } from "../../../../src/infrastructure/a2a-task.repository.js";
import { a2aMessageRowOf } from "../../../../src/infrastructure/a2a-task-pages.js";
import {
  InMemoryA2ADirectMessageRepository,
  savedA2ADirectMessageOf,
} from "../../../../src/infrastructure/in-memory-a2a-direct-message.repository.js";
import { InMemoryA2ATaskRepository } from "../../../../src/infrastructure/in-memory-a2a-task.repository.js";
import { InMemoryDatabase } from "../../../../src/infrastructure/in-memory-database.js";
import { A2A_DIRECT_MESSAGE_SWEEP_CASES } from "../../../../src/testing/contracts/a2a-direct-message-sweep.cases.js";
import type { A2ADirectMessageStores } from "../../../../src/testing/contracts/a2a-direct-message-data.js";

type Messages = InMemoryA2ADirectMessageRepository;
type Make = (database: InMemoryDatabase) => Messages | A2ADirectMessageStores;

const databaseOf = (store: object): InMemoryDatabase =>
  Reflect.get(store, "database") as InMemoryDatabase;

const NAMES = A2A_DIRECT_MESSAGE_SWEEP_CASES.map((one) => one.name);
const caseNamed = (start: string) => {
  const found = A2A_DIRECT_MESSAGE_SWEEP_CASES.find((one) => one.name.startsWith(start));
  if (found === undefined) throw new Error(start);
  return found;
};
const EXPIRED = "the expired attempts in flight";
const SWEEP = "the sweep removes completed";
const FAILED_TOO = "the sweep frees the id of a failed";
const RESEND = "a resend of a failed message";
const ORDER = "the sweep's pages are oldest first";
const CLAIMS = "the sweep frees the claims";
const FIRST = "a failed message keeps its id's claim";

async function outcomeOf(name: string, make: Make): Promise<"pass" | "fail"> {
  const database = new InMemoryDatabase();
  const made = make(database);
  const stores: A2ADirectMessageStores =
    "messages" in made ? made : { messages: made, tasks: new InMemoryA2ATaskRepository(database) };
  try {
    await caseNamed(name).run({ first: stores, second: stores } as never);
    return "pass";
  } catch {
    return "fail";
  }
}

class Sound extends InMemoryA2ADirectMessageRepository {}

/** The one endpoint the contract's messages belong to. */
const ENDPOINT = "billing";
const cutoffOf = (cutoffs: ReadonlyMap<string, Date>): Date => cutoffs.get(ENDPOINT) ?? new Date(0);
const cutoffsAt = (cutoff: Date): ReadonlyMap<string, Date> => new Map([[ENDPOINT, cutoff]]);

/** The messages a sweep took: the rows that are gone after it ran. */
async function removedBy(
  store: object,
  sweep: () => Promise<number>,
): Promise<A2ADirectMessageRecord[]> {
  const rows = databaseOf(store).a2aDirectMessages;
  const before = new Map(rows);
  await sweep();
  return [...before].filter(([row]) => !rows.has(row)).map(([, kept]) => kept);
}

/** The rows a sweep took, put back: the claims are freed, the messages stay. */
class KeepsRows extends InMemoryA2ADirectMessageRepository {
  override async deleteExpired(cutoffs: ReadonlyMap<string, Date>, limit: number) {
    const gone = await removedBy(this, () => super.deleteExpired(cutoffs, limit));
    for (const kept of gone) databaseOf(this).a2aDirectMessages.set(a2aMessageRowOf(kept), kept);
    return gone.length;
  }
}

/** The claims of the removed messages stay: an id is never free. */
class KeepsClaims extends InMemoryA2ADirectMessageRepository {
  override async deleteExpired(cutoffs: ReadonlyMap<string, Date>, limit: number) {
    const claims = new Map(databaseOf(this).a2aMessages);
    const gone = await super.deleteExpired(cutoffs, limit);
    for (const [row, claim] of claims) databaseOf(this).a2aMessages.set(row, claim);
    return gone;
  }
}

/** Removes every completed message before the cutoff, whatever the limit. */
class IgnoresLimit extends InMemoryA2ADirectMessageRepository {
  override deleteExpired(cutoffs: ReadonlyMap<string, Date>, limit: number) {
    return super.deleteExpired(cutoffs, Math.max(limit, 100));
  }
}

class NewestFirst extends InMemoryA2ADirectMessageRepository {
  override async deleteExpired(cutoffs: ReadonlyMap<string, Date>, limit: number) {
    const all = await removedBy(this, () => super.deleteExpired(cutoffs, 100));
    const taken = [...all].reverse().slice(0, limit);
    // what it did not take is put back
    for (const kept of all.filter((one) => !taken.includes(one)))
      databaseOf(this).a2aDirectMessages.set(a2aMessageRowOf(kept), kept);
    return taken.length;
  }
}

/** Frees the claims of every failed message at once, whatever the limit. */
class FreesAllOrphans extends InMemoryA2ADirectMessageRepository {
  override async deleteExpired(cutoffs: ReadonlyMap<string, Date>, limit: number) {
    const gone = await super.deleteExpired(cutoffs, limit);
    await super.deleteExpired(cutoffs, 100);
    return gone;
  }
}

/** Never frees the claim of a failed message. */
class KeepsOrphans extends InMemoryA2ADirectMessageRepository {
  override async deleteExpired(cutoffs: ReadonlyMap<string, Date>, limit: number) {
    const claims = databaseOf(this).a2aMessages;
    const before = new Map(claims);
    const messages = databaseOf(this).a2aDirectMessages;
    const gone = await removedBy(this, () => super.deleteExpired(cutoffs, limit));
    for (const [row, claim] of before)
      if (
        !claims.has(row) &&
        !gone.some((one) => row.includes(one.messageId)) &&
        !messages.has(row)
      )
        claims.set(row, claim);
    return gone.length;
  }
}

/** Frees the claim of a failed message accepted at the cutoff too. */
class FreesAtCutoff extends InMemoryA2ADirectMessageRepository {
  override async deleteExpired(cutoffs: ReadonlyMap<string, Date>, limit: number) {
    return super.deleteExpired(cutoffsAt(new Date(cutoffOf(cutoffs).getTime() + 1)), limit);
  }
}

/** Removes the claims of every message with no row, a task's too. */
class FreesTaskClaims extends InMemoryA2ADirectMessageRepository {
  override async deleteExpired(cutoffs: ReadonlyMap<string, Date>, limit: number) {
    const gone = await super.deleteExpired(cutoffs, limit);
    const { a2aMessages: claims, a2aDirectMessages: messages } = databaseOf(this);
    for (const [row] of claims) if (!messages.has(row)) claims.delete(row);
    return gone;
  }
}

/** Sweeps a message still in flight too. */
class SweepsInFlight extends InMemoryA2ADirectMessageRepository {
  override async deleteExpired(cutoffs: ReadonlyMap<string, Date>, limit: number) {
    const { a2aMessages: claims, a2aDirectMessages: messages } = databaseOf(this);
    const old = [...messages.entries()].filter(
      ([, kept]) => kept.createdAt.getTime() < cutoffOf(cutoffs).getTime(),
    );
    const gone = await super.deleteExpired(cutoffs, limit);
    for (const [row, kept] of old) {
      if (kept.state === A2ADirectMessageState.InFlight) {
        messages.delete(row);
        claims.delete(row);
      }
    }
    return gone;
  }
}

/** Counts a message's age from its latest attempt: a resent one is young. */
class ClaimAgeOfLatest extends InMemoryA2ADirectMessageRepository {
  override async saveIfAbsent(message: Parameters<Messages["saveIfAbsent"]>[0]) {
    const claims = databaseOf(this).a2aMessages;
    const saved = await super.saveIfAbsent(message);
    for (const [row, claim] of claims)
      if (row === a2aMessageRowOf(message))
        claims.set(row, { ...claim, savedAt: message.createdAt });
    return saved;
  }
}

class ExpiredNewestFirst extends InMemoryA2ADirectMessageRepository {
  override async findAllInFlightByExpiresAtBefore(now: Date, limit: number) {
    return [...(await super.findAllInFlightByExpiresAtBefore(now, 100))].reverse().slice(0, limit);
  }
}

class ExpiredStrict extends InMemoryA2ADirectMessageRepository {
  override findAllInFlightByExpiresAtBefore(now: Date, limit: number) {
    return super.findAllInFlightByExpiresAtBefore(new Date(now.getTime() - 1), limit);
  }
}

class ExpiredIgnoresLimit extends InMemoryA2ADirectMessageRepository {
  override findAllInFlightByExpiresAtBefore(now: Date, limit: number) {
    return super.findAllInFlightByExpiresAtBefore(now, Math.max(limit, 100));
  }
}

class ExpiredWithCompleted extends InMemoryA2ADirectMessageRepository {
  override async findAllInFlightByExpiresAtBefore(now: Date, limit: number) {
    const all = [...databaseOf(this).a2aDirectMessages.values()]
      .filter((kept) => kept.expiresAt.getTime() <= now.getTime())
      .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime());
    return structuredClone(all.slice(0, limit)) as readonly A2ADirectMessageRecord[];
  }
}

/** Takes the rows of the swept messages but leaves them findable: dated far ahead, never swept twice. */
class KeepsRowsFindable extends InMemoryA2ADirectMessageRepository {
  override async deleteExpired(cutoffs: ReadonlyMap<string, Date>, limit: number) {
    const gone = await removedBy(this, () => super.deleteExpired(cutoffs, limit));
    for (const kept of gone)
      databaseOf(this).a2aDirectMessages.set(a2aMessageRowOf(kept), {
        ...kept,
        createdAt: new Date(9e12),
        completedAt: new Date(9e12),
      });
    return gone.length;
  }
}

/** Frees the claim of every message kept, whatever its age. */
class FreesKeptClaims extends InMemoryA2ADirectMessageRepository {
  override async deleteExpired(cutoffs: ReadonlyMap<string, Date>, limit: number) {
    const gone = await super.deleteExpired(cutoffs, limit);
    const { a2aMessages: claims, a2aDirectMessages: messages } = databaseOf(this);
    for (const [row] of messages) claims.delete(row);
    return gone;
  }
}

/** A resend finds the claim, waits, and writes its row without it: a sweep in between frees the claim. */
class RacyResend extends InMemoryA2ADirectMessageRepository {
  protected answer: "saved" | "kept" = "saved";
  override async saveIfAbsent(message: Parameters<Messages["saveIfAbsent"]>[0]) {
    const { a2aMessages: claims, a2aDirectMessages: messages } = databaseOf(this);
    const row = a2aMessageRowOf(message);
    if (!claims.has(row) || messages.has(row)) return super.saveIfAbsent(message);
    await Promise.resolve();
    const saved = { ...savedA2ADirectMessageOf(message) };
    messages.set(row, saved);
    return this.answer === "saved"
      ? { status: A2ADirectMessageSaveStatus.Saved as const, message: saved }
      : { status: A2ADirectMessageSaveStatus.Kept as const, message: saved };
  }
}

class RacyResendAnswersKept extends RacyResend {
  protected override answer = "kept" as const;
}

/** Answers a refused task `TaskIdTaken`, whoever has the message. */
class TasksAnswerTaskIdTaken extends InMemoryA2ATaskRepository {
  override async saveIfAbsent(task: Parameters<InMemoryA2ATaskRepository["saveIfAbsent"]>[0]) {
    const save = await super.saveIfAbsent(task);
    return save.status === A2ATaskSaveStatus.MessageTaken
      ? { status: A2ATaskSaveStatus.TaskIdTaken as const }
      : save;
  }
}

/** Answers a resend `Saved` with a fresh claim and no row: the message is lost, its id held. */
class LosesTheResend extends InMemoryA2ADirectMessageRepository {
  override async saveIfAbsent(message: Parameters<Messages["saveIfAbsent"]>[0]) {
    const claims = databaseOf(this).a2aMessages;
    const row = a2aMessageRowOf(message);
    const claim = claims.get(row);
    if (claim === undefined) return super.saveIfAbsent(message);
    claims.set(row, { ...claim, savedAt: message.createdAt });
    return {
      status: A2ADirectMessageSaveStatus.Saved as const,
      message: savedA2ADirectMessageOf(message),
    };
  }
}

/** One row of the page: when it was kept, its id, whether it is a completed message. */
interface PageRow {
  readonly at: number;
  readonly id: string;
  readonly isDone: boolean;
}

/** The completed messages and the failed ones' claims older than `cutoff`, by row. */
function pageRowsOf(store: object, cutoff: number): Map<string, PageRow> {
  const { a2aMessages: claims, a2aDirectMessages: messages } = databaseOf(store);
  const rows = new Map<string, PageRow>();
  for (const [row, kept] of messages) {
    const at = kept.completedAt?.getTime() ?? cutoff;
    if (kept.state === A2ADirectMessageState.Completed && at < cutoff)
      rows.set(row, { at, id: kept.messageId, isDone: true });
  }
  for (const [row, claim] of claims)
    if (!messages.has(row) && claim.taskId === "" && claim.savedAt.getTime() < cutoff)
      rows.set(row, { at: claim.savedAt.getTime(), id: claim.messageId, isDone: false });
  return rows;
}

/** One page of the completed messages and the failed ones' claims, oldest first, a tie by id, newest. */
class OnePageOfBoth extends InMemoryA2ADirectMessageRepository {
  override deleteExpired(cutoffs: ReadonlyMap<string, Date>, limit: number) {
    const { a2aMessages: claims, a2aDirectMessages: messages } = databaseOf(this);
    const page = [...pageRowsOf(this, cutoffOf(cutoffs).getTime()).entries()]
      .sort(([, a], [, b]) => a.at - b.at || (a.id < b.id ? 1 : -1))
      .slice(0, limit);
    for (const [row] of page) {
      messages.delete(row);
      claims.delete(row);
    }
    return Promise.resolve(page.filter(([, one]) => one.isDone).length);
  }
}

/** Keeps a failed message's claim, and takes an empty request hash for no hash to compare. */
class KeepsOrphansEmptyHashFits extends InMemoryA2ADirectMessageRepository {
  override async deleteExpired(cutoffs: ReadonlyMap<string, Date>, limit: number) {
    const claims = databaseOf(this).a2aMessages;
    const before = new Map(claims);
    const gone = await removedBy(this, () => super.deleteExpired(cutoffs, limit));
    for (const [row, claim] of before)
      if (!claims.has(row) && !gone.some((one) => a2aMessageRowOf(one) === row))
        claims.set(row, claim);
    return gone.length;
  }

  override saveIfAbsent(message: Parameters<Messages["saveIfAbsent"]>[0]) {
    return super.saveIfAbsent(
      message.requestHash === "" ? { ...message, requestHash: "h-1" } : message,
    );
  }
}

const withTasks =
  (tasks: (d: InMemoryDatabase) => InMemoryA2ATaskRepository): Make =>
  (d) => ({
    messages: new InMemoryA2ADirectMessageRepository(d),
    tasks: tasks(d),
  });
const BROKEN2: readonly (readonly [string, string, Make])[] = [
  [SWEEP, "sweep keeps the rows findable", (d) => new KeepsRowsFindable(d)],
  [SWEEP, "sweep frees the claims of kept messages", (d) => new FreesKeptClaims(d)],
  [RESEND, "a resend racing a sweep loses its claim", (d) => new RacyResend(d)],
  [RESEND, "a resend answered saved, its row lost", (d) => new LosesTheResend(d)],
  [RESEND, "a resend racing a sweep, answered kept", (d) => new RacyResendAnswersKept(d)],
  [RESEND, "tasks answer TaskIdTaken", withTasks((d) => new TasksAnswerTaskIdTaken(d))],
  [CLAIMS, "one page of messages and failed claims", (d) => new OnePageOfBoth(d)],
  [FAILED_TOO, "failed claims kept, empty hash fits", (d) => new KeepsOrphansEmptyHashFits(d)],
];

const BROKEN: readonly (readonly [string, string, Make])[] = [
  [SWEEP, "sweep keeps the rows", (d) => new KeepsRows(d)],
  [SWEEP, "sweep keeps the claims", (d) => new KeepsClaims(d)],
  [SWEEP, "sweep ignores the limit", (d) => new IgnoresLimit(d)],
  [SWEEP, "sweep newest first", (d) => new NewestFirst(d)],
  [FAILED_TOO, "sweep keeps failed claims", (d) => new KeepsOrphans(d)],
  [FAILED_TOO, "sweep frees task claims", (d) => new FreesTaskClaims(d)],
  [ORDER, "sweep newest first", (d) => new NewestFirst(d)],
  [ORDER, "found newest first", (d) => new ExpiredNewestFirst(d)],
  [CLAIMS, "sweep frees all orphans", (d) => new FreesAllOrphans(d)],
  [CLAIMS, "sweep keeps the claims", (d) => new KeepsClaims(d)],
  [FIRST, "sweep frees at cutoff", (d) => new FreesAtCutoff(d)],
  [FIRST, "claim aged by latest attempt", (d) => new ClaimAgeOfLatest(d)],
  [FIRST, "sweep keeps failed claims", (d) => new KeepsOrphans(d)],
  [EXPIRED, "found newest first", (d) => new ExpiredNewestFirst(d)],
  [EXPIRED, "found strictly before", (d) => new ExpiredStrict(d)],
  [EXPIRED, "found ignores the limit", (d) => new ExpiredIgnoresLimit(d)],
  [EXPIRED, "found with completed", (d) => new ExpiredWithCompleted(d)],
];

describe("#1366: the direct-message sweep cases", () => {
  it("the cases pass on the sound store", async () => {
    for (const name of NAMES)
      expect([name, await outcomeOf(name, (d) => new Sound(d))]).toEqual([name, "pass"]);
  });

  for (const [name, broken, make] of [...BROKEN, ...BROKEN2]) {
    it(`${name.slice(0, 40)}... fails on: ${broken}`, async () => {
      expect(await outcomeOf(name, make)).toBe("fail");
    });
  }
});
