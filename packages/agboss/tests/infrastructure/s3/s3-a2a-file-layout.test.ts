/**
 * #904 item 4: every key `S3A2AFileRepository` writes fits S3 and MinIO — each segment at most 255
 * bytes, the key at most 1024 — for every valid id (a key's text: 1 to 200 UTF-16 code units), a
 * digest past the length an id may take; an id the key names is read back; a prefix that leaves no
 * room is refused.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  fileKeyOf,
  indexEntryOf,
  indexKeyOf,
  MAX_PREFIX_BYTES,
  prefixProblemOf,
  segmentOf,
  textOf,
} from "../../../src/infrastructure/s3/s3-a2a-file-layout.js";

const bytesOf = (text: string): number => Buffer.byteLength(text, "utf8");

/** A key S3 takes: segments ≤ 255 bytes, the whole ≤ 1024. */
const fits = (key: string): boolean =>
  bytesOf(key) <= 1024 && key.split("/").every((segment) => bytesOf(segment) <= 255);

const anyId = fc
  .string({ unit: "grapheme", minLength: 1, maxLength: 200 })
  .filter((text) => text.length <= 200);
const prefix = "p".repeat(MAX_PREFIX_BYTES - 1) + "/";

describe("#904 item 4: the bucket's layout", () => {
  it("AC4.1 every key of any ids fits, the prefix at its longest; an id is read back or is a digest (property)", () => {
    fc.assert(
      fc.property(anyId, anyId, anyId, (tenantId, ownerId, fileId) => {
        const file = {
          tenantId,
          ownerId,
          fileId,
          mediaType: "application/pdf",
          sha256: "a".repeat(64),
          sizeBytes: 1,
          createdAt: new Date("2026-01-05T09:00:00.000Z"),
        };
        const index = indexKeyOf(file);
        const entry = indexEntryOf(index);

        expect(fits(`${prefix}${index}`)).toBe(true);
        expect(fits(`${prefix}${fileKeyOf(segmentOf(tenantId), segmentOf(fileId))}`)).toBe(true);
        expect(entry?.tenant).toBe(segmentOf(tenantId));
        expect([tenantId, undefined]).toContain(textOf(segmentOf(tenantId)));
      }),
      { numRuns: 300 },
    );
  });

  it("AC4.2 a 200-character ASCII id stays readable; 200 three-byte characters are a digest", () => {
    expect(textOf(segmentOf("t".repeat(200)))).toBe("t".repeat(200));
    expect(segmentOf("€".repeat(200))).toMatch(/^h\.[\w-]{43}$/);
    expect(textOf(segmentOf("€".repeat(200)))).toBeUndefined();
  });

  it("AC4.3 a prefix that leaves no room for the longest key is refused, naming its size", () => {
    expect(prefixProblemOf(prefix)).toBeUndefined();
    expect(prefixProblemOf(`${prefix}x`)).toBe(
      `a2aS3Prefix is ${String(MAX_PREFIX_BYTES + 1)} bytes: at most ${String(MAX_PREFIX_BYTES)} keep every key within S3's 1024`,
    );
  });
});
