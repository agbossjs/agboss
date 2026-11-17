/**
 * #1269 (mutation shard files-pii): `historyDescriptorsOf` and `historySourcesOf` — which lines of the
 * remembered turns hold descriptors, how each is named and de-duplicated, and how a stored one is copied.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { A2AFileDto } from "../../src/a2a/files/a2a-file.dto.js";
import { sha256Of, type FileReadContext } from "../../src/files/file-bytes.js";
import { resolvedFilesOf } from "../../src/files/file-settings.js";
import { historyDescriptorsOf, historySourcesOf } from "../../src/files/history-files.js";
import type { FileRuntime, SourceFile } from "../../src/files/visit-files.js";
import type { HistoryTurn } from "../../src/flow/runtime/history.js";
import type { NewA2AFile } from "../../src/infrastructure/a2a-file.repository.js";
import { InMemoryA2AFileRepository } from "../../src/infrastructure/in-memory-a2a-file.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import { VirtualClock } from "../../src/testing/clock.js";
import { kilobytes, megabytes, seconds } from "../../src/units/index.js";
import { PNG } from "../a2a/files/support.js";
import { NO_REDACTION } from "./runtime-parts.js";

const png = (source: Record<string, string>): A2AFileDto => ({ mediaType: "image/png", ...source });
const turn = (start: string, finish = "finish f: {}"): HistoryTurn => ({ start, finish });
const startOf = (value: unknown, name = "s"): string => `start ${name}: ${JSON.stringify(value)}`;
const finishOf = (value: unknown, name = "f"): string => `finish ${name}: ${JSON.stringify(value)}`;

describe("historyDescriptorsOf: which lines hold descriptors", () => {
  it("a line is `start|finish <name>: <json>` from its first character: text before it holds none", () => {
    const file = png({ fileId: "f1" });

    expect(historyDescriptorsOf([turn(`x ${startOf(file)}`)])).toEqual([]);
    expect(historyDescriptorsOf([turn("not a turn line at all")])).toEqual([]);
    expect(historyDescriptorsOf([turn(startOf(file))])).toHaveLength(1);
  });

  it("the json may hold spaces and line breaks, and a name holds no colon", () => {
    const file = png({ fileId: "f1" });
    const pretty = `start s: ${JSON.stringify({ a: { b: file } }, null, 2)}`;

    expect(historyDescriptorsOf([turn(pretty)]).map((found) => found.descriptor)).toEqual([file]);
  });

  it("a line that is no JSON holds no descriptor and does not stop the others", () => {
    const file = png({ fileId: "f1" });

    const found = historyDescriptorsOf([turn("start s: {oops", finishOf(file))]);

    expect(found.map((one) => one.descriptor)).toEqual([file]);
  });

  it("descriptors are found at any depth: in arrays, in objects, past nulls", () => {
    const [a, b, c] = [
      png({ fileId: "a" }),
      png({ url: "https://x.example/b" }),
      png({ fileId: "c" }),
    ];

    const found = historyDescriptorsOf([
      turn(startOf({ list: [a, [b]], none: null, deep: { nothing: null, file: c } })),
    ]);

    expect(found.map((one) => one.descriptor)).toEqual([a, b, c]);
  });

  it("an array of files and a primitive-only array both read", () => {
    const a = png({ fileId: "a" });

    expect(
      historyDescriptorsOf([turn(startOf([1, "x", null, a]))]).map((o) => o.descriptor),
    ).toEqual([a]);
  });
});

describe("historyDescriptorsOf: how each is named", () => {
  it("each carries its turn's number, its line's kind and name, and its producer", () => {
    const a = png({ fileId: "a" });
    const b = png({ fileId: "b" });

    const found = historyDescriptorsOf([
      turn(startOf({}), finishOf({}, "x")),
      turn(startOf(a, "one"), finishOf(b, "two")),
    ]);

    expect(found).toEqual([
      { descriptor: a, field: "turn 2 start one", producer: "an earlier turn" },
      { descriptor: b, field: "turn 2 finish two", producer: "an earlier turn" },
    ]);
  });

  it("the first turn is turn 1", () => {
    const [found] = historyDescriptorsOf([turn(startOf(png({ fileId: "a" }), "n"))]);

    expect(found?.field).toBe("turn 1 start n");
  });
});

describe("historyDescriptorsOf: each file once, oldest first", () => {
  it("the same descriptor in two lines is listed once, where it was first said", () => {
    const a = png({ fileId: "a" });

    const found = historyDescriptorsOf([turn(startOf(a), finishOf(a)), turn(startOf(a, "later"))]);

    expect(found.map((one) => one.field)).toEqual(["turn 1 start s"]);
  });

  it("two files of other ids, other urls or other digests are two files", () => {
    const files = [
      png({ fileId: "a" }),
      png({ fileId: "b" }),
      png({ url: "https://x.example/1" }),
      png({ url: "https://x.example/2" }),
      png({ fileId: "a", sha256: "1".repeat(64) }),
      png({ fileId: "a", sha256: "2".repeat(64) }),
    ];

    const found = historyDescriptorsOf([turn(startOf(files))]);

    expect(found).toHaveLength(files.length);
  });

  it("a missing id, url or digest is not a file of that literal value", () => {
    const text = "Stryker was here!";
    const files = [
      png({ inline: "aA==" }),
      png({ fileId: text, sha256: text }),
      png({ fileId: "f" }),
      png({ fileId: "f", sha256: text }),
      png({ url: text }),
      png({ fileId: text }),
    ];

    const found = historyDescriptorsOf([turn(startOf(files))]);

    expect(found).toHaveLength(files.length);
  });
});

/** A store that keeps what it is told to save, and can lose bytes. */
class RecordingStore extends InMemoryA2AFileRepository {
  readonly saved: NewA2AFile[] = [];
  isLosingBytes = false;

  override save(file: NewA2AFile): Promise<void> {
    this.saved.push(file);
    return super.save(file);
  }

  override findBytes(...args: Parameters<InMemoryA2AFileRepository["findBytes"]>) {
    return this.isLosingBytes ? Promise.resolve(undefined) : super.findBytes(...args);
  }
}

const OWNER = "root-2";
const now = new Date("2026-03-04T05:06:07.000Z");

function setup(owners: readonly string[] = ["root-1", OWNER]) {
  const store = new RecordingStore(new InMemoryDatabase());
  const context: FileReadContext = {
    store,
    tenantId: "acme",
    ownerId: OWNER,
    signal: new AbortController().signal,
    clock: new VirtualClock(now),
    transport: () => Promise.reject(new Error("no network")),
    allowedOrigins: [],
    fetchTimeout: seconds(5),
    maxFileSize: kilobytes(1),
  };
  const runtime: FileRuntime = {
    agent: "reader-agent",
    settings: resolvedFilesOf({
      agent: {},
      defaults: undefined,
      skills: [],
      a2aFiles: undefined,
      hasPiiPolicy: false,
    }),
    maxResultSize: megabytes(1),
    context: () => context,
    transcribe: () => Promise.reject(new Error("no transcriber")),
    transcriberKey: () => "t",
    ...NO_REDACTION,
    threadOwners: () => Promise.resolve(owners),
  };
  return { store, runtime };
}

const SHA = sha256Of(PNG);
const keep = (store: RecordingStore, fileId: string, ownerId: string, filename?: string) =>
  store.save({
    tenantId: "acme",
    fileId,
    ownerId,
    mediaType: "image/png",
    ...(filename === undefined ? {} : { filename }),
    sha256: SHA,
    sizeBytes: PNG.byteLength,
    createdAt: new Date(0),
    bytes: PNG,
  });
const sourceOf = (descriptor: A2AFileDto): SourceFile => ({
  descriptor,
  field: "f",
  producer: "p",
});
const sourcesFor = (descriptors: readonly A2AFileDto[]) =>
  descriptors.map((descriptor, index) =>
    turn(startOf(descriptor, `n${String(index)}`), "finish f: {}"),
  );

describe("historySourcesOf: a stored file of an earlier turn", () => {
  it("a file by url, or inline, is shown as it is: the store is not asked", async () => {
    const { runtime, store } = setup();
    const url = png({ url: "https://x.example/a" });
    const inline = png({ inline: "aA==" });

    const sources = await historySourcesOf(sourcesFor([url, inline]), runtime);

    expect(sources.map((one) => one.descriptor)).toEqual([url, inline]);
    expect(sources.some((one) => one.isRemoved === true)).toBe(false);
    expect(store.saved).toEqual([]);
  });

  it("a file the store does not know is removed", async () => {
    const { runtime } = setup();
    const gone = png({ fileId: "gone" });

    const [source] = await historySourcesOf(sourcesFor([gone]), runtime);

    expect(source).toEqual({
      ...sourceOf(gone),
      field: "turn 1 start n0",
      producer: "an earlier turn",
      isRemoved: true,
    });
  });

  it("a file of the reading execution itself is used as it is, not copied", async () => {
    const { runtime, store } = setup();
    await keep(store, "mine", OWNER);
    const mine = png({ fileId: "mine" });

    const [source] = await historySourcesOf(sourcesFor([mine]), runtime);

    expect(source?.descriptor).toEqual(mine);
    expect(source?.isRemoved).toBeUndefined();
    expect(store.saved).toHaveLength(1);
  });

  it("a file of an execution that is no turn of the thread is removed, whatever its bytes", async () => {
    const { runtime, store } = setup(["root-1"]);
    await keep(store, "alien", "someone-else");

    const [source] = await historySourcesOf(sourcesFor([png({ fileId: "alien" })]), runtime);

    expect(source?.isRemoved).toBe(true);
    expect(store.saved).toHaveLength(1);
  });

  it("a thread file whose bytes retention took is removed too", async () => {
    const { runtime, store } = setup();
    await keep(store, "lost", "root-1");
    store.isLosingBytes = true;

    const [source] = await historySourcesOf(sourcesFor([png({ fileId: "lost" })]), runtime);

    expect(source?.isRemoved).toBe(true);
    expect(source?.descriptor).toEqual(png({ fileId: "lost" }));
    expect(store.saved).toHaveLength(1);
  });

  it("a thread file is copied under the reading execution, the copy's id fixed by owner and bytes", async () => {
    const { runtime, store } = setup();
    await keep(store, "theirs", "root-1", "scan.png");
    const expected = `history-${createHash("sha256").update(`${OWNER}:${SHA}`).digest("hex").slice(0, 40)}`;

    const [source] = await historySourcesOf(sourcesFor([png({ fileId: "theirs" })]), runtime);

    expect(expected).toHaveLength("history-".length + 40);
    expect(source?.descriptor).toEqual(png({ fileId: expected }));
    expect(source?.isRemoved).toBeUndefined();
    const copy = store.saved[1];
    expect(copy).toEqual({
      tenantId: "acme",
      fileId: expected,
      ownerId: OWNER,
      mediaType: "image/png",
      filename: "scan.png",
      sha256: SHA,
      sizeBytes: PNG.byteLength,
      createdAt: now,
      bytes: PNG,
    });
  });

  it("a thread file without a filename is copied without one", async () => {
    const { runtime, store } = setup();
    await keep(store, "theirs", "root-1");

    await historySourcesOf(sourcesFor([png({ fileId: "theirs" })]), runtime);

    expect(Object.keys(store.saved[1] ?? {})).not.toContain("filename");
  });

  it("the same bytes under another owner are another copy; the same owner reads the same copy", async () => {
    const first = setup();
    await keep(first.store, "theirs", "root-1");
    const a = await historySourcesOf(sourcesFor([png({ fileId: "theirs" })]), first.runtime);
    const b = await historySourcesOf(sourcesFor([png({ fileId: "theirs" })]), first.runtime);

    expect(a[0]?.descriptor.fileId).toBe(b[0]?.descriptor.fileId);
    expect(a[0]?.descriptor.fileId).not.toBe("theirs");
  });
});
