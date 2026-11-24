/**
 * #1316b security review: a stored or inline file with no digest is refused by `Files.read`; one
 * pool per set of pool fields, never per object; a skill's pool only tightens its workflow's, and a
 * skill whose start cannot be found is said, not skipped.
 */
import { describe, expect, it } from "vitest";
import { a2aFileStoreViolations } from "../../src/a2a/a2a-file-store-rule.js";
import { A2AExpose } from "../../src/a2a/a2a-expose.decorator.js";
import { appFileSlotsOf } from "../../src/a2a/files/a2a-file-pool.js";
import { Files } from "../../src/a2a/files/files.service.js";
import { FileError } from "../../src/core/error-families/remote-errors.js";
import { FileRefusal, FileUnavailableReason } from "../../src/files/file-errors.js";
import { FilePolicy, filePolicyExcesses } from "../../src/files/file-policy.js";
import { InlineFileRepository } from "../../src/infrastructure/file.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { InMemoryFileRepository } from "../../src/infrastructure/in-memory-file.repository.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { FileReviewWorkflow, FileReviewWorkflowStart } from "../a2a/fixtures/files.application.js";
import { PDF, TEXT } from "../a2a/files/support.js";
import { inTestFrame } from "../helpers/frame.js";

const clock = new VirtualClock(new Date("2026-01-05T09:00:00.000Z"));
const reasonOf = (work: Promise<unknown>) =>
  work.then(
    () => "read",
    (error: unknown) =>
      error instanceof FileError.Unavailable ? error.reason : (error as FileError.Refused).refusal,
  );
const withoutDigest = <T extends { sha256?: string }>(file: T): T => {
  const { sha256: _digest, ...rest } = file;
  return rest as T;
};

describe("#1316b review: Files.read needs a digest of a stored or inline file", () => {
  it("a stored file and an inline file with no sha256 are unavailable; with one they read", async () => {
    const files = new Files(new InMemoryFileRepository(new InMemoryDatabase()), clock);
    const stored = await inTestFrame(() =>
      files.save({ bytes: PDF, mediaType: "application/pdf" }),
    );
    const inline = await inTestFrame(() =>
      new Files(new InlineFileRepository(), clock).save({ bytes: TEXT, mediaType: "text/plain" }),
    );

    expect(await reasonOf(inTestFrame(() => files.read(withoutDigest(stored))))).toBe(
      FileUnavailableReason.DigestMissing,
    );
    expect(await reasonOf(inTestFrame(() => files.read(withoutDigest(inline))))).toBe(
      FileUnavailableReason.DigestMissing,
    );
    expect(await reasonOf(inTestFrame(() => files.read(stored)))).toBe("read");
    expect(await reasonOf(inTestFrame(() => files.read(inline)))).toBe("read");
  });

  it("a file by url needs no digest: it goes on to the policy's origin check", async () => {
    const files = new Files(new InMemoryFileRepository(new InMemoryDatabase()), clock);

    expect(
      await reasonOf(
        inTestFrame(() =>
          files.read(files.fromUrl("https://f.example/a", { mediaType: "text/plain" })),
        ),
      ),
    ).toBe(FileRefusal.OriginDenied);
  });
});

describe("#1316b review: a pool is keyed by its fields", () => {
  it("two equal pool objects of one application are one pool, and its caps hold across them", async () => {
    const store = {};
    const a = appFileSlotsOf(store, { maxConcurrent: 1, maxConcurrentPerTenant: 1 });
    const b = appFileSlotsOf(store, { maxConcurrent: 1, maxConcurrentPerTenant: 1 });
    const other = appFileSlotsOf(store, { maxConcurrent: 2, maxConcurrentPerTenant: 2 });

    expect(b).toBe(a);
    expect(other).not.toBe(a);
    const caller = { tenant: '["t"]', owner: '["t","o"]' };
    let running = 0;
    let peak = 0;
    const work = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setImmediate(resolve));
      running -= 1;
    };
    const never = new AbortController().signal;
    const fail = () => new Error("busy");

    await Promise.all([
      a.run(never, work, fail, caller),
      b.run(never, work, fail, caller),
      a.run(never, work, fail, caller),
    ]);

    expect(peak).toBe(1);
  });
});

describe("#1316b review: a child's pool only tightens its parent's", () => {
  const excess = (parent: object | undefined, child: object) => {
    @FilePolicy({ ...(parent === undefined ? {} : { fetchPool: parent }) })
    class Parent {}
    @FilePolicy({ fetchPool: child })
    class Child {}
    return filePolicyExcesses(parent === undefined ? undefined : Parent, Child);
  };

  it("above the parent's pool is refused, field by field", () => {
    expect(excess({ maxConcurrent: 4 }, { maxConcurrent: 8 })).toContain(
      "fetchPool.maxConcurrent 8 is above 4",
    );
    expect(excess({ maxQueuedPerOwner: 2 }, { maxQueuedPerOwner: 3 })).toEqual([
      "fetchPool.maxQueuedPerOwner 3 is above 2",
    ]);
    expect(excess({ maxConcurrent: 4 }, { maxConcurrent: 2 })).toEqual([]);
  });

  it("under the shared pool, a child pool must be strictly smaller", () => {
    expect(excess(undefined, { maxConcurrent: 32 })).toContain(
      "fetchPool.maxConcurrent 32 is above 16",
    );
    expect(excess(undefined, { maxConcurrent: 16 })).toHaveLength(1);
    expect(excess(undefined, { maxConcurrent: 8 })).toEqual([]);
  });

  it("a skill whose start is not exported is said, not skipped", () => {
    @FilePolicy({ maxFiles: 1 })
    class Narrow {}
    @A2AExpose({
      name: "orphan-skill-a2a-expose",
      version: "1.0.0",
      description: "files",
      exports: [FileReviewWorkflowStart],
      skills: { "no-such-skill": { filePolicy: Narrow } },
    })
    class Expose {}

    const found = a2aFileStoreViolations({
      name: "rules-application",
      workflows: [FileReviewWorkflow],
      exposes: [Expose],
    } as never);

    expect(found.map(({ code }) => code)).toContain("a2a.skill-file-policy-exceeds-workflow");
  });
});
