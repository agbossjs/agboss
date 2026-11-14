/** #1013 (acceptance): a lock is made complete beside its place and renamed in, never made in place. */
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it, vi } from "vitest";

/** What the mocked fs saw: folders made, and what a folder renamed to the lock held at that moment. */
const seen = vi.hoisted(() => ({
  made: [] as string[],
  atRename: [] as { to: string; held: string[] }[],
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdirSync: ((path: string, options?: never): void => {
      seen.made.push(basename(path));
      actual.mkdirSync(path, options);
    }) as typeof actual.mkdirSync,
    renameSync: (from: string, to: string) => {
      seen.atRename.push({ to: basename(to), held: actual.readdirSync(from) });
      actual.renameSync(from, to);
    },
  };
});

const { LOCK_NAME, withSyncLock } = await import("../../src/skills/lock.js");
const { OWNER_PREFIX } = await import("../../src/skills/lock-owner.js");

describe("#1013 AC1: the lock is created atomically", () => {
  it("AC1: the lock folder is never made in place; at its rename it already holds its owner file", () => {
    const root = mkdtempSync(join(tmpdir(), "agboss-atomic-"));

    withSyncLock(root, () => 1);

    expect(seen.made).not.toContain(LOCK_NAME);
    const into = seen.atRename.filter((move) => move.to === LOCK_NAME);
    expect(into).toHaveLength(1);
    expect(into[0]?.held).toHaveLength(1);
    expect(into[0]?.held[0]?.startsWith(OWNER_PREFIX)).toBe(true);
    expect(readdirSync(join(root, ".agents"))).toEqual([]);
  });
});
