/**
 * #859: `S3FileRepository` passes the A2A file contract on an S3-compatible store (two instances
 * on one bucket, each request's Signature Version 4 checked), and its signing is AWS's own: the
 * documented example of a signed GET gives the documented signature.
 */
import { bytes as byteSize } from "../../../src/units/index.js";
import { describe, expect, it } from "vitest";
import { secret } from "../../../src/environments/secret.js";
import { resolveReferences } from "../../../src/environments/define-env.js";
import type { ResolvedSettings } from "../../../src/storage/settings.js";
import { S3FileRepository } from "../../../src/infrastructure/s3/s3-file.repository.js";
import { authorizationOf } from "../../../src/infrastructure/s3/s3-signing.js";
import { fileContract } from "../../../src/testing/contracts/index.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { FakeS3, S3_BUCKET, S3_ENDPOINT, S3_KEYS, S3_REGION } from "./fake-s3.js";

let bucket = new FakeS3();

const PROCESS_ENV = {
  A2A_S3_ACCESS_KEY_ID: S3_KEYS.accessKeyId,
  A2A_S3_SECRET_ACCESS_KEY: S3_KEYS.secretAccessKey,
};

/** What `@ObjectStorage({ driver: S3Driver(…) })` resolves to: the driver's options with their references read. */
const settingsOf = (given: Record<string, unknown>): ResolvedSettings =>
  resolveReferences({ kind: "s3", ...given }, PROCESS_ENV, "test") as ResolvedSettings;

const SETTINGS = settingsOf({
  bucket: S3_BUCKET,
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  accessKeyId: secret("A2A_S3_ACCESS_KEY_ID"),
  secretAccessKey: secret("A2A_S3_SECRET_ACCESS_KEY"),
});

fileContract({
  name: "S3",
  reset: () => {
    bucket = new FakeS3();
  },
  instance: ({ clock }) => new S3FileRepository(clock, SETTINGS, bucket.fetcher),
});

describe("#859: S3FileRepository", () => {
  it("signs as AWS documents it (the GET-object example of Signature Version 4)", () => {
    const authorization = authorizationOf(
      {
        method: "GET",
        url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
        headers: {
          host: "examplebucket.s3.amazonaws.com",
          range: "bytes=0-9",
          "x-amz-content-sha256":
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          "x-amz-date": "20130524T000000Z",
        },
        payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        region: "us-east-1",
        amzDate: "20130524T000000Z",
      },
      {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      },
    );

    expect(authorization).toBe(
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
    );
  });

  it("the sweep reads the index only up to the cutoff: an owner not yet up is never listed past, read or touched", async () => {
    const s3 = new FakeS3();
    const store = new S3FileRepository(new VirtualClock(), SETTINGS, s3.fetcher);
    const at = new Date("2026-01-05T09:00:00.000Z");
    const owners = ["a", "b", "c", "d", "e", "f"];
    for (const [index, owner] of owners.entries()) {
      await store.save({
        tenantId: "default",
        fileId: `${owner}.0`,
        ownerId: owner,
        mediaType: "text/plain",
        sha256: "a".repeat(64),
        sizeBytes: byteSize(1),
        createdAt: at,
        bytes: Uint8Array.from([1]),
      });
      // completed an hour apart: a at 09:00 … f at 14:00
      await store.markOwnerCompleted({
        tenantId: "default",
        ownerId: owner,
        workflow: "w",
        completedAt: new Date(at.getTime() + index * 3_600_000),
      });
    }
    s3.listed.length = 0;
    s3.requests.length = 0;

    // a 1 hour ttl at 11:30: a (09:00) and b (10:00) are up, c (11:00) is not (11:00 + 1h > 11:30... 12:00)
    const now = new Date(at.getTime() + 2.5 * 3_600_000);
    const removed = await store.deleteExpired({
      now,
      cutoffsByWorkflow: new Map([["w", new Date(now.getTime() - 3_600_000)]]),
    });

    const requests = [...s3.requests];

    expect(removed).toBe(2);
    expect(await store.findMetadata({ tenantId: "default", fileId: "a.0" })).toBeUndefined();
    expect(await store.findMetadata({ tenantId: "default", fileId: "b.0" })).toBeUndefined();
    expect(await store.findMetadata({ tenantId: "default", fileId: "c.0" })).toBeDefined();
    // never the files, nor the index of the owners not yet up
    const touched = (owner: string) =>
      requests.filter((request) =>
        request.includes(Buffer.from(`${owner}.0`).toString("base64url")),
      );
    expect(["c", "d", "e", "f"].flatMap(touched)).toEqual([]);
  });

  it("#1316: the index keys: completed/<workflow>/<utc time>/<tenant>/<owner>, and expires/<utc time>/… for a file with a ttl of its own", async () => {
    const s3 = new FakeS3();
    const store = new S3FileRepository(new VirtualClock(), SETTINGS, s3.fetcher);
    const at = new Date("2026-01-05T09:00:00.000Z");
    await store.save({
      tenantId: "default",
      fileId: "a.0",
      ownerId: "a",
      mediaType: "text/plain",
      sha256: "a".repeat(64),
      sizeBytes: byteSize(1),
      createdAt: at,
      ttl: 60_000 as never,
      bytes: Uint8Array.from([1]),
    });

    await store.markOwnerCompleted({
      tenantId: "default",
      ownerId: "a",
      workflow: "w",
      completedAt: at,
    });

    const keys = [...s3.objects.keys()];
    expect(keys.filter((key) => key.includes("/completed/"))).toEqual([
      expect.stringMatching(/\/completed\/[\w-]+\/2026-01-05T09:00:00\.000Z\/[\w-]+\/[\w-]+$/),
    ]);
    expect(keys.filter((key) => key.includes("/expires/"))).toEqual([
      expect.stringMatching(/\/expires\/2026-01-05T09:01:00\.000Z\/[\w-]+\/[\w-]+\/[\w-]+$/),
    ]);
  });

  it("names the driver option it misses, never a value", () => {
    expect(() => new S3FileRepository({} as never, settingsOf({ region: "x" }))).toThrow(
      "S3Driver needs bucket",
    );
  });

  it("reads nothing but the object storage's settings: with none, it names the @ObjectStorage to declare", () => {
    expect(() => new S3FileRepository({} as never, undefined)).toThrow(
      "S3FileRepository needs the application's @ObjectStorage",
    );
  });
});
