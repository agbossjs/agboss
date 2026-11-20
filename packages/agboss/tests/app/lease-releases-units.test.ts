/**
 * #1356 (cancel shard) — the wake-up of the calls of this process that wait for a tree's lease (#265, Q58): a
 * release of the tree wakes its watchers and no others, a closed watch is woken by nothing, and the book of
 * watched trees holds none of a tree that no call watches.
 */
import { afterEach, describe, expect, it } from "vitest";
import { leaseReleases, type ReleaseWatch } from "../../src/app/lease-releases.js";

const open: ReleaseWatch[] = [];
const watch = (key: string): ReleaseWatch => {
  const made = leaseReleases.watch(key);
  open.push(made);
  return made;
};

afterEach(() => {
  for (const each of open.splice(0)) each.close();
});

/** A wait between two tries that ends only when its signal aborts. */
const untilAborted = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    signal.addEventListener("abort", () => {
      resolve();
    });
  });

/** What `wait` handed its retry: whether the signal was aborted when the retry ran. */
const abortedAtRetry = async (
  made: ReleaseWatch,
  signal?: AbortSignal,
): Promise<boolean | undefined> => {
  let aborted: boolean | undefined;
  await made.wait((end) => {
    aborted = end.aborted;
    return Promise.resolve();
  }, signal);
  return aborted;
};

describe("#1356: a release wakes the calls waiting for its tree", () => {
  it("every watcher of the tree, and no watcher of another", async () => {
    const [a, b, other] = [watch("tree-1"), watch("tree-1"), watch("tree-2")];
    const woken: string[] = [];
    const waits = [
      a.wait(untilAborted, undefined).then(() => woken.push("a")),
      b.wait(untilAborted, undefined).then(() => woken.push("b")),
    ];

    leaseReleases.notify("tree-1");
    await Promise.all(waits);

    expect(woken.sort()).toEqual(["a", "b"]);
    expect(await abortedAtRetry(other)).toBe(false);
  });

  it("a wake-up before the wait is not lost: the watch is open before the lease is tried", async () => {
    const made = watch("tree-1");

    leaseReleases.notify("tree-1");

    expect(await abortedAtRetry(made)).toBe(true);
  });

  it("the caller's own signal ends the wait too, with or without a watcher's wake-up", async () => {
    const made = watch("tree-1");
    const caller = new AbortController();
    const waited = made.wait(untilAborted, caller.signal);

    caller.abort();
    await waited;

    expect(await abortedAtRetry(made, new AbortController().signal)).toBe(false);
    expect(await abortedAtRetry(made, AbortSignal.abort())).toBe(true);
  });

  it("a notify of a tree nobody watches wakes nothing and fails nothing", () => {
    expect(() => {
      leaseReleases.notify("tree-nobody-watches");
    }).not.toThrow();
  });
});

describe("#1356: a closed watch", () => {
  it("is woken by no release", async () => {
    const closed = leaseReleases.watch("tree-1");
    closed.close();

    leaseReleases.notify("tree-1");

    expect(await abortedAtRetry(closed)).toBe(false);
  });

  it("leaves the others of its tree watching", async () => {
    const [closed, kept] = [leaseReleases.watch("tree-1"), watch("tree-1")];
    closed.close();

    leaseReleases.notify("tree-1");

    expect(await abortedAtRetry(kept)).toBe(true);
  });
});

describe("#1356: the book of watched trees", () => {
  it("holds a tree while a call watches it, once however many do, and none after the last closes", () => {
    const before = leaseReleases.watched;
    const [a, b] = [leaseReleases.watch("tree-book"), leaseReleases.watch("tree-book")];

    expect(leaseReleases.watched).toBe(before + 1);
    a.close();
    expect(leaseReleases.watched).toBe(before + 1);
    b.close();
    expect(leaseReleases.watched).toBe(before);
  });

  it("a watch closed twice does not take the book of a later watcher of the tree with it", async () => {
    const before = leaseReleases.watched;
    const first = leaseReleases.watch("tree-book");
    first.close();
    const second = watch("tree-book");

    first.close();

    expect(leaseReleases.watched).toBe(before + 1);
    leaseReleases.notify("tree-book");
    expect(await abortedAtRetry(second)).toBe(true);
  });
});
