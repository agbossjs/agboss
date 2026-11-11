/**
 * #859: `S3A2AFileRepository` passes the A2A file contract on an S3-compatible store (two instances
 * on one bucket, each request's Signature Version 4 checked), and its signing is AWS's own: the
 * documented example of a signed GET gives the documented signature.
 */
import { describe, expect, it } from "vitest";
import { secret } from "../../../src/environments/secret.js";
import { resolveEnvironment } from "../../../src/environments/resolve.js";
import {
  applicationContextOf,
  type ApplicationContext,
} from "../../../src/flow/context/application-context.js";
import { S3A2AFileRepository } from "../../../src/infrastructure/s3/s3-a2a-file.repository.js";
import { authorizationOf } from "../../../src/infrastructure/s3/s3-signing.js";
import { a2aFileContract } from "../../../src/testing/contracts/index.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { FakeS3, S3_BUCKET, S3_ENDPOINT, S3_KEYS, S3_REGION } from "./fake-s3.js";

let bucket = new FakeS3();

const PROCESS_ENV = {
  A2A_S3_ACCESS_KEY_ID: S3_KEYS.accessKeyId,
  A2A_S3_SECRET_ACCESS_KEY: S3_KEYS.secretAccessKey,
};

/** An application context of this environment, as an instance makes one. */
const contextOf = (
  values: Record<string, unknown>,
  processEnv: NodeJS.ProcessEnv = {},
): ApplicationContext =>
  applicationContextOf({
    name: "files-application",
    version: "1.0.0",
    instanceId: "instance-1",
    startedAt: new Date("2026-01-05T09:00:00.000Z"),
    environmentName: "test",
    environment: resolveEnvironment(
      { name: "test", contract: "FilesEnvironment", values },
      processEnv,
    ),
  });

const ENVIRONMENT = {
  a2aS3Bucket: S3_BUCKET,
  a2aS3Region: S3_REGION,
  a2aS3Endpoint: S3_ENDPOINT,
  a2aS3AccessKeyId: secret("A2A_S3_ACCESS_KEY_ID"),
  a2aS3SecretAccessKey: secret("A2A_S3_SECRET_ACCESS_KEY"),
};

a2aFileContract({
  name: "S3",
  reset: () => {
    bucket = new FakeS3();
  },
  instance: ({ clock }) =>
    new S3A2AFileRepository(contextOf(ENVIRONMENT, PROCESS_ENV), clock, bucket.fetcher),
});

describe("#859: S3A2AFileRepository", () => {
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

  it("a page of owners lists from past the cursor and stops at the limit: never the whole index", async () => {
    const s3 = new FakeS3();
    const store = new S3A2AFileRepository(
      contextOf(ENVIRONMENT, PROCESS_ENV),
      new VirtualClock(),
      s3.fetcher,
    );
    const at = new Date("2026-01-05T09:00:00.000Z");
    for (const owner of ["a", "b", "c", "d", "e", "f"])
      await store.save({
        tenantId: "default",
        fileId: `${owner}.0`,
        ownerId: owner,
        mediaType: "text/plain",
        sha256: "a".repeat(64),
        sizeBytes: 1,
        createdAt: at,
        bytes: Uint8Array.from([1]),
      });
    s3.listed.length = 0;

    const first = await store.findOwnersByCreatedAtBefore(new Date("2026-01-06T00:00:00.000Z"), 2);
    const firstListed = s3.listed.length;
    s3.listed.length = 0;
    const next = await store.findOwnersByCreatedAtBefore(
      new Date("2026-01-06T00:00:00.000Z"),
      2,
      first.at(-1),
    );

    expect(first.map((owner) => owner.ownerId)).toEqual(["a", "b"]);
    expect(next.map((owner) => owner.ownerId)).toEqual(["c", "d"]);
    expect([firstListed, s3.listed.length]).toEqual([2, 2]);
  });

  it("names the environment field it misses, never a value", () => {
    expect(() => new S3A2AFileRepository(contextOf({ a2aS3Region: "x" }), {} as never)).toThrow(
      "S3A2AFileRepository needs a2aS3Bucket in the environment",
    );
  });
});
