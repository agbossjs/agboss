/**
 * #1269 (files-pii mutation shard): a copy read again from the store is asked for by what is known of it —
 * its type, its id, its digest and its name only when it has one.
 */
import { describe, expect, it, vi } from "vitest";
import type { A2AFileDto } from "../../src/a2a/files/a2a-file.dto.js";

const asked = vi.hoisted(() => ({ descriptors: [] as unknown[] }));

vi.mock("../../src/files/file-bytes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/files/file-bytes.js")>();
  return {
    ...actual,
    fileContentOf: (file: A2AFileDto, context: Parameters<typeof actual.fileContentOf>[1]) => {
      asked.descriptors.push(file);
      return actual.fileContentOf(file, context);
    },
  };
});

import { sha256Of } from "../../src/files/file-bytes.js";
import { redactedKeyOf, redactedViewOf } from "../../src/files/redacted-view.js";
import { InMemoryA2AFileRepository } from "../../src/infrastructure/in-memory-a2a-file.repository.js";
import { InMemoryDatabase } from "../../src/infrastructure/in-memory-database.js";
import {
  batchOf,
  maskOf,
  NOW,
  OWNER,
  png,
  runtimeOf,
  TENANT,
} from "./mutation-b-redacted-view.fixture.js";
import { PNG_BYTES } from "./reader.factory.js";

describe("a stored copy is read by its descriptor", () => {
  it("the descriptor has the name when the entry has one, and no name key when it has none", async () => {
    const store = new InMemoryA2AFileRepository(new InMemoryDatabase());
    const bytes = Buffer.concat([PNG_BYTES, Buffer.from("-copy")]);
    await store.save({
      tenantId: TENANT,
      fileId: "kept-1",
      ownerId: OWNER,
      mediaType: "image/png",
      sha256: sha256Of(bytes),
      sizeBytes: bytes.byteLength,
      createdAt: NOW,
      bytes,
    });
    const mask = maskOf();
    const runtime = runtimeOf({ store });
    const key = redactedKeyOf(batchOf(runtime, mask), png(), mask);
    const entryOf = (extra: object) =>
      JSON.stringify({
        mediaType: "image/png",
        sha256: sha256Of(bytes),
        fileId: "kept-1",
        ...extra,
      });

    await redactedViewOf(
      batchOf(runtime, mask, { [key]: entryOf({ filename: "card.png" }) }),
      png(),
      "h",
    );
    await redactedViewOf(batchOf(runtime, mask, { [key]: entryOf({}) }), png(), "h");

    expect(asked.descriptors).toEqual([
      { mediaType: "image/png", fileId: "kept-1", sha256: sha256Of(bytes), filename: "card.png" },
      { mediaType: "image/png", fileId: "kept-1", sha256: sha256Of(bytes) },
    ]);
    expect("filename" in (asked.descriptors[1] as object)).toBe(false);
  });
});
