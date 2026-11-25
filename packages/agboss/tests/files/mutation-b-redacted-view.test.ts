/**
 * #1269 (files-pii mutation shard): the redacted view of one file — its cache key, what is asked of the
 * redactor, what an answer must be to be kept, how the copy is kept (inline or in the store) and what
 * every refusal says. Called directly on a batch, with a redactor and a mask that are told what to do.
 */
import { StepError } from "../../src/core/error-families/step-errors.js";
import { bytes as byteSize } from "../../src/units/index.js";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Of, type FileContent } from "../../src/files/file-bytes.js";
import {
  MAX_INLINE_REDACTED,
  redactedKeyOf,
  redactedViewOf,
} from "../../src/files/redacted-view.js";
import { InMemoryFileRepository } from "../../src/infrastructure/in-memory-file.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import type { NewFile } from "../../src/infrastructure/file.repository.js";
import { PiiKind } from "../../src/pii/kinds.js";
import { PNG_BYTES } from "./reader.factory.js";
import {
  AGENT,
  batchOf,
  JPEG_BYTES,
  maskOf,
  NOW,
  OWNER,
  png,
  pngOfSize,
  rejection,
  runtimeOf,
  TENANT,
} from "./mutation-b-redacted-view.fixture.js";

const HEADING = "### card";

/** A store that keeps what it is given where a test can see it. */
class SpyStore extends InMemoryFileRepository {
  readonly saved: NewFile[] = [];
  constructor(private readonly failure?: Error) {
    super(new InMemoryDatabase());
  }

  override save(file: NewFile): Promise<void> {
    this.saved.push(file);
    return this.failure === undefined ? super.save(file) : Promise.reject(this.failure);
  }
}

const failureOf = async (promise: Promise<unknown>): Promise<StepError.FileMaskingFailed> => {
  const error = await rejection(promise);
  expect(error).toBeInstanceOf(StepError.FileMaskingFailed);
  return error as StepError.FileMaskingFailed;
};

describe("the cache key of a redacted copy", () => {
  it("names the bytes, the redactor, whether values were told, and the keyed digest of what was told", () => {
    const content = png();
    const kinds = redactedKeyOf(
      batchOf(runtimeOf(), maskOf({ values: ["Dana"] })),
      content,
      maskOf({ values: ["Dana"] }),
    );
    const values = redactedKeyOf(
      batchOf(runtimeOf({ sendsValues: true }), maskOf({ values: ["Dana", "Avi"] })),
      content,
      maskOf({ values: ["Dana", "Avi"] }),
    );

    expect(kinds).toBe(`redacted:${content.sha256}:rk:kinds-only:digest()`);
    expect(values).toBe(`redacted:${content.sha256}:rk:values:digest(Dana|Avi)`);
  });
});

describe("what is kept, and where", () => {
  it("without a file store the copy rides inline, with its name, in the cache entry under the key", async () => {
    const original = png(PNG_BYTES, "card.png");
    const copy = png(Buffer.concat([PNG_BYTES, Buffer.from("-copy")]), "card.png");
    const mask = maskOf();
    const batch = batchOf(
      runtimeOf({ redact: () => Promise.resolve({ file: copy, found: [] }) }),
      mask,
    );

    const view = await redactedViewOf(batch, original, HEADING);

    expect(view.made?.key).toBe(redactedKeyOf(batch, original, mask));
    expect(JSON.parse(view.made?.entry ?? "")).toEqual({
      mediaType: "image/png",
      sha256: copy.sha256,
      filename: "card.png",
      inline: Buffer.from(copy.bytes).toString("base64"),
    });
    expect(view.viewed).toEqual(copy);
  });

  it("a copy with no name is kept with none", async () => {
    const copy = png(Buffer.concat([PNG_BYTES, Buffer.from("-copy")]));
    const batch = batchOf(
      runtimeOf({ redact: () => Promise.resolve({ file: copy, found: [] }) }),
      maskOf(),
    );

    const view = await redactedViewOf(batch, png(), HEADING);

    expect(Object.keys(JSON.parse(view.made?.entry ?? "") as object).sort()).toEqual([
      "inline",
      "mediaType",
      "sha256",
    ]);
  });

  it("inline, a copy of exactly 64 KB is kept and one byte more is refused, with both sizes", async () => {
    const at = pngOfSize(MAX_INLINE_REDACTED);
    const over = pngOfSize(MAX_INLINE_REDACTED + 1);
    const redactTo = (file: FileContent) =>
      batchOf(runtimeOf({ redact: () => Promise.resolve({ file, found: [] }) }), maskOf());

    const kept = await redactedViewOf(redactTo(at), png(), HEADING);
    const error = await failureOf(redactedViewOf(redactTo(over), png(), HEADING));

    expect(JSON.parse(kept.made?.entry ?? "")).toHaveProperty("inline");
    expect(error.agent).toBe(AGENT);
    expect(error.reason).toBe(
      "the redacted copy is 65537 bytes, over the 65536 an execution keeps without a file store",
    );
  });

  it("with a file store the copy is saved there, owned by the root execution, under an id of its owner and digest", async () => {
    const store = new SpyStore();
    const copy = png(Buffer.concat([PNG_BYTES, Buffer.from("-copy")]), "card.png");
    const batch = batchOf(
      runtimeOf({ store, redact: () => Promise.resolve({ file: copy, found: [] }) }),
      maskOf(),
    );

    const view = await redactedViewOf(batch, png(), HEADING);

    const expectedId = `redacted-${createHash("sha256").update(`${OWNER}:${copy.sha256}`).digest("hex").slice(0, 40)}`;
    expect(expectedId).toHaveLength(49);
    expect(JSON.parse(view.made?.entry ?? "")).toEqual({
      mediaType: "image/png",
      sha256: copy.sha256,
      filename: "card.png",
      fileId: expectedId,
    });
    expect(store.saved).toEqual([
      {
        tenantId: TENANT,
        fileId: expectedId,
        ownerId: OWNER,
        mediaType: "image/png",
        sha256: copy.sha256,
        sizeBytes: copy.bytes.byteLength,
        createdAt: NOW,
        filename: "card.png",
        bytes: copy.bytes,
      },
    ]);
    expect(await store.findBytes({ tenantId: TENANT, fileId: expectedId })).toEqual(
      Uint8Array.from(copy.bytes),
    );
  });

  it("a copy with no name is saved with none; a copy over 64 KB is no limit of a store", async () => {
    const store = new SpyStore();
    const copy = pngOfSize(MAX_INLINE_REDACTED + 10);
    const batch = batchOf(
      runtimeOf({ store, redact: () => Promise.resolve({ file: copy, found: [] }) }),
      maskOf(),
    );

    const view = await redactedViewOf(batch, png(), HEADING);

    expect("filename" in (store.saved[0] ?? {})).toBe(false);
    expect(Object.keys(JSON.parse(view.made?.entry ?? "") as object).sort()).toEqual([
      "fileId",
      "mediaType",
      "sha256",
    ]);
  });

  it("a store that cannot keep the copy fails the redaction, with the store's error as the cause", async () => {
    const down = new Error("the store is down");
    const batch = batchOf(runtimeOf({ store: new SpyStore(down) }), maskOf());

    const error = await failureOf(redactedViewOf(batch, png(), HEADING));

    expect(error.reason).toBe("the redacted copy cannot be kept");
    expect(error.agent).toBe(AGENT);
    expect(error.cause).toBe(down);
  });
});

describe("a copy made once is read again, never made twice", () => {
  const countingRedactor = () => {
    const calls: FileContent[] = [];
    const copy = (file: FileContent): FileContent =>
      png(Buffer.concat([file.bytes, Buffer.from("-copy")]), file.filename);
    return {
      calls,
      redact: (file: FileContent) => {
        calls.push(file);
        return Promise.resolve({ file: copy(file), found: [] });
      },
    };
  };

  it("an inline entry gives the copy's bytes, digest and name, with no redactor call and no model budget check", async () => {
    const redactor = countingRedactor();
    const first = await redactedViewOf(
      batchOf(runtimeOf(redactor), maskOf()),
      png(PNG_BYTES, "card.png"),
      HEADING,
    );
    let budgetChecks = 0;
    const batch = batchOf(
      runtimeOf(redactor),
      maskOf(),
      { [first.made?.key ?? ""]: first.made?.entry ?? "" },
      () => {
        budgetChecks += 1;
      },
    );

    const again = await redactedViewOf(batch, png(PNG_BYTES, "card.png"), HEADING);

    expect(redactor.calls).toHaveLength(1);
    expect(budgetChecks).toBe(0);
    expect(Buffer.from(again.viewed.bytes).equals(first.viewed.bytes)).toBe(true);
    expect({ ...again.viewed, bytes: 0 }).toEqual({ ...first.viewed, bytes: 0 });
    expect(again.viewed.filename).toBe("card.png");
    expect(again.viewed.sha256).toBe(sha256Of(again.viewed.bytes));
    expect(again).not.toHaveProperty("made");
    expect(again.usage).toEqual([]);
  });

  it("an inline entry with no name gives a copy with no name at all", async () => {
    const redactor = countingRedactor();
    const first = await redactedViewOf(batchOf(runtimeOf(redactor), maskOf()), png(), HEADING);
    const batch = batchOf(runtimeOf(redactor), maskOf(), {
      [first.made?.key ?? ""]: first.made?.entry ?? "",
    });

    const again = await redactedViewOf(batch, png(), HEADING);

    expect(Object.keys(again.viewed).sort()).toEqual(["bytes", "mediaType", "sha256"]);
  });

  it("a stored entry is read again from the store, through the digest it was kept under", async () => {
    const store = new SpyStore();
    const redactor = countingRedactor();
    const first = await redactedViewOf(
      batchOf(runtimeOf({ ...redactor, store }), maskOf()),
      png(PNG_BYTES, "card.png"),
      HEADING,
    );
    const batch = batchOf(runtimeOf({ ...redactor, store }), maskOf(), {
      [first.made?.key ?? ""]: first.made?.entry ?? "",
    });

    const again = await redactedViewOf(batch, png(PNG_BYTES, "card.png"), HEADING);

    expect(redactor.calls).toHaveLength(1);
    expect(Buffer.from(again.viewed.bytes).equals(first.viewed.bytes)).toBe(true);
    expect({ ...again.viewed, bytes: 0 }).toEqual({ ...first.viewed, bytes: 0 });
    expect(again.viewed.filename).toBe("card.png");
  });

  it("a stored entry with no name gives a copy with no name at all", async () => {
    const store = new SpyStore();
    const redactor = countingRedactor();
    const first = await redactedViewOf(
      batchOf(runtimeOf({ ...redactor, store }), maskOf()),
      png(),
      HEADING,
    );
    const batch = batchOf(runtimeOf({ ...redactor, store }), maskOf(), {
      [first.made?.key ?? ""]: first.made?.entry ?? "",
    });

    const again = await redactedViewOf(batch, png(), HEADING);

    expect(Object.keys(again.viewed).sort()).toEqual(["bytes", "mediaType", "sha256"]);
  });

  it("an entry that names neither bytes nor a file is a file that is not kept, whatever the store holds", async () => {
    const store = new SpyStore();
    const bytes = Buffer.concat([PNG_BYTES, Buffer.from("-planted")]);
    await store.save({
      tenantId: TENANT,
      fileId: "Stryker was here!",
      ownerId: OWNER,
      mediaType: "image/png",
      sha256: sha256Of(bytes),
      sizeBytes: byteSize(bytes.byteLength),
      createdAt: NOW,
      bytes,
    });
    const mask = maskOf();
    const batch = batchOf(runtimeOf({ store }), mask);
    const entry = JSON.stringify({ mediaType: "image/png", sha256: sha256Of(bytes) });
    const cached = batchOf(runtimeOf({ store }), mask, {
      [redactedKeyOf(batch, png(), mask)]: entry,
    });

    const error = await rejection(redactedViewOf(cached, png(), HEADING));

    expect(error).toMatchObject({ code: "files.unavailable" });
  });
});
