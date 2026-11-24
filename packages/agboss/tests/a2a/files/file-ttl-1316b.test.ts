/**
 * #1316b: files age by `@FilePolicy.ttl`, counted from the end of the execution's whole tree —
 * never while it runs or waits paused; the sweep (`deleteExpired`) counts what it removes; a
 * file's own `ttl` is at most its policy's; `retention.a2aFiles` is gone.
 */
import { describe, expect, it } from "vitest";
import { fileExpiryOf } from "../../../src/application/file-expiry.js";
import { FileError } from "../../../src/core/error-families/remote-errors.js";
import { FileRefusal } from "../../../src/files/file-errors.js";
import { forgetTree } from "../../../src/app/tree-ends.js";
import { Files } from "../../../src/a2a/files/files.service.js";
import { a2aFileStoreViolations } from "../../../src/a2a/a2a-file-store-rule.js";
import { FilePolicy, filePolicyExcesses, fileLimitsOf } from "../../../src/files/file-policy.js";
import { Workflow } from "../../../src/flow/decorators/workflow.js";
import { runInFrame } from "../../../src/flow/context/frame.js";
import { InMemoryDatabase } from "../../../src/infrastructure/in-memory-database.js";
import { InMemoryFileRepository } from "../../../src/infrastructure/in-memory-file.repository.js";
import { removeExpired } from "../../../src/infrastructure/retention-sweep.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { bytes as byteSize, hours, minutes, Ttl } from "../../../src/units/index.js";
import { FileReviewWorkflow, fileReviewFlow } from "../fixtures/files.application.js";
import { PDF } from "./support.js";
import { testFrame } from "../../helpers/frame.js";
import { ComponentOptions } from "../../../src/components/component-options.js";

const START = new Date("2026-01-05T09:00:00.000Z");

/** A store, a clock and the sweep as the recovery look runs it, over the fixture workflow (ttl 24 hours). */
function lifecycle(workflows: readonly (new () => object)[] = [FileReviewWorkflow]) {
  const clock = new VirtualClock(START);
  const files = new InMemoryFileRepository(new InMemoryDatabase());
  const live = new Set<string>();
  const expiry = fileExpiryOf({
    files,
    clock,
    workflows,
    options: ComponentOptions.none,
    isLive: (owner) => Promise.resolve(live.has(owner.ownerId)),
  });
  const sweep = async () =>
    (
      await removeExpired(
        {
          clock,
          pauses: undefined as never,
          pauseRecordRetention: hours(24),
          expiries: [expiry],
        },
        () => undefined,
      )
    ).filter(({ what }) => what === expiry.what);
  const save = (ownerId: string, ttl?: number) =>
    files.save({
      tenantId: "default",
      fileId: `${ownerId}.0`,
      ownerId,
      mediaType: "application/pdf",
      sha256: "a".repeat(64),
      sizeBytes: byteSize(3),
      createdAt: clock.now(),
      ...(ttl === undefined ? {} : { ttl: ttl as never }),
      bytes: Uint8Array.from([1, 2, 3]),
    });
  const has = async (ownerId: string) =>
    (await files.findMetadata({ tenantId: "default", fileId: `${ownerId}.0` })) !== undefined;
  const complete = (ownerId: string) =>
    files.markOwnerCompleted({
      tenantId: "default",
      ownerId,
      workflow: "file-review-workflow",
      completedAt: clock.now(),
    });
  return { clock, files, sweep, save, has, complete, live };
}

describe("#1316b: a file of a live execution is never swept", () => {
  it("a running or paused execution keeps its file however long, an ended one's goes after the ttl: counted", async () => {
    const stores = lifecycle();
    await stores.save("paused");
    // a paused execution has its record: live to the orphan sweep
    stores.live.add("paused");
    await stores.save("done");
    await stores.complete("done");

    await stores.clock.advance(hours(24 * 30));
    const first = await stores.sweep();

    expect(await stores.has("paused")).toBe(true);
    expect(await stores.has("done")).toBe(false);
    expect(first).toEqual([{ what: "the files of ended executions", removed: 1 }]);
    expect((await stores.sweep())[0]?.removed).toBe(0);
  });

  it("the ttl counts from the end, not from the save: a file saved days before the end is kept for the ttl after it", async () => {
    const stores = lifecycle();
    await stores.save("long-run");
    await stores.clock.advance(hours(72));
    await stores.complete("long-run");

    await stores.clock.advance(hours(23));
    await stores.sweep();
    const within = await stores.has("long-run");
    await stores.clock.advance(hours(2));
    await stores.sweep();

    expect(within).toBe(true);
    expect(await stores.has("long-run")).toBe(false);
  });

  it("a file's own shorter ttl is up from the end plus that ttl, its sibling's workflow ttl follows", async () => {
    const stores = lifecycle();
    await stores.save("short", minutes(10));
    await stores.save("sibling");
    await stores.complete("short");
    await stores.files.markOwnerCompleted({
      tenantId: "default",
      ownerId: "sibling",
      workflow: "file-review-workflow",
      completedAt: stores.clock.now(),
    });

    await stores.clock.advance(minutes(11));
    const [early] = await stores.sweep();

    expect([early?.removed, await stores.has("short"), await stores.has("sibling")]).toEqual([
      1,
      false,
      true,
    ]);
  });
});

describe("#1316b: orphans", () => {
  it("a file of a crashed attempt goes after ORPHAN_AFTER; a live owner's of the same age stays; a younger one stays", async () => {
    const stores = lifecycle();
    await stores.save("crashed");
    await stores.save("running");
    stores.live.add("running");

    await stores.clock.advance(minutes(29));
    await stores.save("fresh");
    const early = await stores.sweep();
    await stores.clock.advance(minutes(2));
    const late = await stores.sweep();

    expect(early[0]?.removed).toBe(0);
    expect(late[0]?.removed).toBe(1);
    expect(await stores.has("crashed")).toBe(false);
    expect(await stores.has("running")).toBe(true);
    expect(await stores.has("fresh")).toBe(true);
  });

  it("an owner that completed is the ttl's, never the orphan sweep's", async () => {
    const stores = lifecycle();
    await stores.save("done");
    await stores.complete("done");

    await stores.clock.advance(hours(2));
    await stores.sweep();

    expect(await stores.has("done")).toBe(true);
  });
});

describe("#1316b: the tree's end marks its owner completed", () => {
  it("forgetTree stamps markOwnerCompleted with the workflow and the clock, once: a second end keeps the first moment", async () => {
    const stores = lifecycle();
    await stores.save("run-1");
    const parts = {
      deps: {
        container: { get: () => stores.files },
        config: { name: "file-review-workflow" },
        turns: { forgetStatusHistory: () => Promise.resolve() },
      },
      trees: { deleteAllInTree: () => Promise.resolve() },
      clock: stores.clock,
    } as never;
    const state = { tenantId: "default", runId: "run-1", threadId: "t", startedVersion: "1" };

    await forgetTree(parts, state);
    await stores.clock.advance(hours(20));
    await forgetTree(parts, state);
    await stores.clock.advance(hours(5));
    await stores.sweep();

    expect(await stores.has("run-1")).toBe(false);
  });
});

describe("#1316b: Files.save({ ttl })", () => {
  const files = () =>
    new Files(
      new InMemoryFileRepository(new InMemoryDatabase()),
      new VirtualClock(START),
      ComponentOptions.none,
    );
  const inPolicy = <T>(ttl: number | Ttl.Forever, work: () => Promise<T>): Promise<T> => {
    @FilePolicy({ ttl: ttl as never })
    class Policy {}
    @Workflow({
      name: `ttl-${String(ttl)}-workflow`,
      version: "1.0.0",
      historyTtl: Ttl.Forever,
      flow: fileReviewFlow,
      filePolicy: Policy,
    })
    class TtlWorkflow {}
    const frame = testFrame();
    const workflow = { ...frame.execution.workflow, type: TtlWorkflow } as never;
    return runInFrame({ ...frame, execution: { ...frame.execution, workflow } }, work);
  };

  it("a save over its policy's ttl is refused; one at most it is kept with it; the default is the policy's", async () => {
    const service = files();
    let count = 0;
    const save = (ttl?: number) =>
      service.save({
        bytes: Uint8Array.from([...PDF, (count += 1)]),
        mediaType: "application/pdf",
        ...(ttl === undefined ? {} : { ttl: ttl as never }),
      });
    const store = Reflect.get(service, "store") as InMemoryFileRepository;
    const ttlOf = async (descriptor: { fileId?: string }) =>
      (await store.findMetadata({ tenantId: "default", fileId: descriptor.fileId ?? "" }))?.ttl;

    const over = inPolicy(hours(1), () => save(hours(2))).catch((error: unknown) => error);
    const at = await inPolicy(hours(1), () => save(minutes(5)));
    const dflt = await inPolicy(hours(1), () => save());
    const forever = await inPolicy(Ttl.Forever, () => save());
    const foreverShort = await inPolicy(Ttl.Forever, () => save(minutes(5)));

    expect(await over).toBeInstanceOf(FileError.Refused);
    expect(((await over) as FileError.Refused).refusal).toBe(FileRefusal.TtlAbovePolicy);
    expect(await ttlOf(at)).toBe(minutes(5));
    expect(await ttlOf(dflt)).toBe(hours(1));
    expect(await ttlOf(forever)).toBeUndefined();
    expect(await ttlOf(foreverShort)).toBe(minutes(5));
  });
});

describe("#1316b: the policy's ttl", () => {
  it("is 24 hours with no policy, and what the policy says otherwise", () => {
    @FilePolicy({ ttl: Ttl.Forever })
    class Forever {}

    expect(fileLimitsOf(undefined).ttl).toBe(hours(24));
    expect(fileLimitsOf(Forever).ttl).toBe(Ttl.Forever);
  });
});

describe("#1316b: the ttl rules", () => {
  const codes = (found: readonly { readonly code: string }[]) => found.map(({ code }) => code);

  it("[file-policy.ttl-required-on-workflow]: a workflow's policy with no ttl; [file-policy.invalid] for a ttl that is no duration", () => {
    @FilePolicy({ allowedMediaTypes: ["text/plain"] })
    class NoTtl {}
    @FilePolicy({ ttl: 0 as never })
    class ZeroTtl {}
    const appOf = (filePolicy: new () => object) => {
      @Workflow({
        name: `rule-${filePolicy.name}-workflow`,
        version: "1.0.0",
        historyTtl: Ttl.Forever,
        flow: fileReviewFlow,
        filePolicy,
      })
      class RuleWorkflow {}
      return { name: "rules-application", workflows: [RuleWorkflow], endpoints: [] } as never;
    };

    expect(codes(a2aFileStoreViolations(appOf(NoTtl), ComponentOptions.none))).toEqual([
      "file-policy.ttl-required-on-workflow",
    ]);
    expect(codes(a2aFileStoreViolations(appOf(ZeroTtl), ComponentOptions.none))).toEqual([
      "file-policy.invalid",
    ]);
  });

  it("a skill's policy may omit the ttl or shorten it, never lengthen it", () => {
    @FilePolicy({ ttl: hours(2) })
    class Parent {}
    @FilePolicy({ ttl: hours(3) })
    class Longer {}
    @FilePolicy({ ttl: Ttl.Forever })
    class Forever {}
    @FilePolicy({ ttl: hours(1) })
    class Shorter {}
    @FilePolicy({ maxFiles: 1 })
    class Silent {}

    expect(filePolicyExcesses(Parent, Longer)).toEqual([
      `ttl ${String(hours(3))} is above ${String(hours(2))}`,
    ]);
    expect(filePolicyExcesses(Parent, Forever)).toHaveLength(1);
    expect(filePolicyExcesses(Parent, Shorter)).toEqual([]);
    expect(filePolicyExcesses(Parent, Silent)).toEqual([]);
    expect(filePolicyExcesses(Forever, Parent)).toEqual([]);
  });
});
