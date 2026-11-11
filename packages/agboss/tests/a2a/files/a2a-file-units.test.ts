/**
 * #859 AC3: the rules of a file, one by one — the descriptor's own rule, the media check of the
 * bytes, the addresses a file is never fetched from, the fetch of a file by url (origins, redirects,
 * size, time, the request's end) and the options a skill's files are bounded by.
 */
import type { LookupAddress } from "node:dns";
import { describe, expect, it } from "vitest";
import { maxBodySizeOf } from "../../../src/a2a/a2a-http.js";
import {
  A2AFileDto,
  A2AFileSource,
  fileFieldsOf,
  fileSourceOf,
  WorkflowFinishFileDto,
  WorkflowFinishFilesDto,
} from "../../../src/a2a/files/a2a-file.dto.js";
import { guardedLookupOf, isDeniedAddress } from "../../../src/a2a/files/a2a-file-address.js";
import {
  fetchedFile,
  MAX_REDIRECTS,
  type FileFetch,
} from "../../../src/a2a/files/a2a-file-fetch.js";
import {
  DEFAULT_A2A_FILE_LIMITS,
  fileLimitsOf,
  fileOptionsViolations,
} from "../../../src/a2a/files/a2a-file-options.js";
import { isOfMediaType } from "../../../src/a2a/files/a2a-media-check.js";
import { validate } from "../../../src/dto/schema.js";
import { VirtualClock } from "../../../src/testing/clock.js";
import { kilobytes, seconds, type Bytes } from "../../../src/units/index.js";
import { ReviewRequestDto } from "../fixtures/files.application.js";
import { PDF, PNG, scriptedTransport, TEXT } from "./support.js";

const SHA = "a".repeat(64);

describe("#859: the file descriptor (A2AFileDto)", () => {
  it("is exactly one of fileId, inline or url; bytes name their digest and size", () => {
    const ok = [
      { mediaType: "application/pdf", fileId: "t.0", sha256: SHA, sizeBytes: 3 },
      { mediaType: "text/plain", inline: "aGk=", sha256: SHA, sizeBytes: 2 },
      { mediaType: "text/plain", url: "https://files.example/a.txt" },
    ];
    const bad = [
      { mediaType: "text/plain" },
      {
        mediaType: "text/plain",
        url: "https://a.example/x",
        inline: "aGk=",
        sha256: SHA,
        sizeBytes: 2,
      },
      { mediaType: "text/plain", inline: "aGk=", sizeBytes: 2 },
      { mediaType: "text/plain", fileId: "t.0", sha256: SHA },
      { mediaType: "text/plain", url: "file:///etc/passwd" },
    ];

    expect(ok.map((file) => fileSourceOf(validate(A2AFileDto, file)))).toEqual([
      A2AFileSource.Stored,
      A2AFileSource.Inline,
      A2AFileSource.Url,
    ]);
    for (const file of bad) expect(() => validate(A2AFileDto, file)).toThrow();
  });

  it("a DTO's file fields: one, a list, in declaration order; the standard finishes'", () => {
    expect(fileFieldsOf(ReviewRequestDto)).toEqual([
      { name: "document", isList: false, isOptional: false },
      { name: "pages", isList: true, isOptional: true },
    ]);
    expect(fileFieldsOf(WorkflowFinishFileDto)).toEqual([
      { name: "file", isList: false, isOptional: false },
    ]);
    expect(fileFieldsOf(WorkflowFinishFilesDto)).toEqual([
      { name: "files", isList: true, isOptional: false },
    ]);
    expect(fileFieldsOf(A2AFileDto)).toEqual([]);
  });
});

describe("#859 AC3: the bytes are what the media type says (magic bytes, UTF-8)", () => {
  it("each checked type takes its own signature and refuses another's", () => {
    const gif = new TextEncoder().encode("GIF89a....");
    const webp = new TextEncoder().encode("RIFF....WEBPVP8 ");
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]);

    expect(
      [
        ["application/pdf", PDF],
        ["image/png", PNG],
        ["image/gif", gif],
        ["image/webp", webp],
        ["image/jpeg", jpeg],
        ["text/plain", TEXT],
        ["application/json", new TextEncoder().encode('{"a":1}')],
      ].map(([type, bytes]) => isOfMediaType(type as string, bytes as Uint8Array)),
    ).toEqual([true, true, true, true, true, true, true]);
    expect(isOfMediaType("application/pdf", PNG)).toBe(false);
    expect(isOfMediaType("image/png", PDF)).toBe(false);
    expect(isOfMediaType("text/plain", Uint8Array.from([0xff, 0xfe, 0x00]))).toBe(false);
    expect(isOfMediaType("application/json", TEXT)).toBe(false);
    expect(isOfMediaType("application/x-own", TEXT)).toBe(true);
  });
});

describe("#859 AC3: the addresses a file is never fetched from (SSRF)", () => {
  it("loopback, private, link-local, unique-local and mapped ones; a public one passes", () => {
    const denied = [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254",
      "100.64.0.1",
      "0.0.0.0",
      "::1",
      "[::1]",
      "fc00::1",
      "fd12::1",
      "fe80::1",
      "::ffff:127.0.0.1",
      "not-an-ip",
    ];

    expect(denied.filter((address) => !isDeniedAddress(address))).toEqual([]);
    expect(isDeniedAddress("93.184.216.34")).toBe(false);
    expect(isDeniedAddress("2606:2800:220:1::1")).toBe(false);
    expect(isDeniedAddress("172.32.0.1")).toBe(false);
  });

  it("a name resolving to a private address among public ones is refused, never raced", async () => {
    const answers: Record<string, LookupAddress[]> = {
      "mixed.example": [
        { address: "93.184.216.34", family: 4 },
        { address: "10.0.0.5", family: 4 },
      ],
      "public.example": [{ address: "93.184.216.34", family: 4 }],
    };
    const lookup = guardedLookupOf((hostname, callback) => {
      callback(null, answers[hostname] ?? []);
    });
    const ask = (hostname: string) =>
      new Promise<{ error: unknown; address: unknown }>((resolve) => {
        lookup(hostname, {}, (error, address) => {
          resolve({ error, address });
        });
      });

    const mixed = await ask("mixed.example");
    const empty = await ask("none.example");
    const fine = await ask("public.example");

    expect(Reflect.get(Object(mixed.error), "code")).toBe("A2A_FILE_ADDRESS_DENIED");
    expect(Reflect.get(Object(empty.error), "code")).toBe("A2A_FILE_ADDRESS_DENIED");
    expect(fine).toEqual({ error: null, address: "93.184.216.34" });
  });
});

const ORIGIN = "https://files.example";

const fetchOf = (
  transport: FileFetch["transport"],
  url: string,
  more: Partial<FileFetch> = {},
): FileFetch => ({
  url,
  allowedOrigins: [ORIGIN],
  maxBytes: kilobytes(64),
  transport,
  clock: new VirtualClock(new Date("2026-01-05T09:00:00.000Z")),
  timeout: seconds(10),
  signal: new AbortController().signal,
  ...more,
});

const codeOf = async (work: Promise<unknown>): Promise<unknown> => {
  try {
    await work;
    return "fetched";
  } catch (error) {
    return (
      Reflect.get(Object(Reflect.get(Object(error), "errorInfo") ?? error), "metadata") ??
      Reflect.get(Object(error), "message")
    );
  }
};

describe("#859 AC3: the fetch of a file by url", () => {
  it("follows at most three redirects on allowed origins, relative ones too", async () => {
    const hops = Object.fromEntries(
      Array.from({ length: MAX_REDIRECTS }, (_, hop) => [
        `${ORIGIN}/${String(hop)}`,
        { status: 302, location: `/${String(hop + 1)}` },
      ]),
    );
    const script = scriptedTransport({ ...hops, [`${ORIGIN}/3`]: { body: PDF } });

    const bytes = await fetchedFile(fetchOf(script.transport, `${ORIGIN}/0`));

    expect(Buffer.from(bytes)).toEqual(Buffer.from(PDF));
    expect(script.asked).toHaveLength(MAX_REDIRECTS + 1);
  });

  it("a fourth redirect, a non-2xx answer, an unreachable host: a2a.file-fetch-failed", async () => {
    const hops = Object.fromEntries(
      Array.from({ length: MAX_REDIRECTS + 1 }, (_, hop) => [
        `${ORIGIN}/${String(hop)}`,
        { status: 301, location: `${ORIGIN}/${String(hop + 1)}` },
      ]),
    );
    const script = scriptedTransport({ ...hops, [`${ORIGIN}/gone`]: { status: 404, body: TEXT } });

    const codes = await Promise.all(
      [`${ORIGIN}/0`, `${ORIGIN}/gone`, `${ORIGIN}/nowhere`].map((url) =>
        codeOf(fetchedFile(fetchOf(script.transport, url))),
      ),
    );

    expect(codes).toEqual([
      expect.objectContaining({ code: "a2a.file-fetch-failed" }),
      expect.objectContaining({ code: "a2a.file-fetch-failed" }),
      expect.objectContaining({ code: "a2a.file-fetch-failed" }),
    ]);
  });

  it("no origin allowed, http:, another origin: refused before anything is asked", async () => {
    const script = scriptedTransport({});

    const codes = await Promise.all([
      codeOf(fetchedFile(fetchOf(script.transport, `${ORIGIN}/a`, { allowedOrigins: [] }))),
      codeOf(fetchedFile(fetchOf(script.transport, "http://files.example/a"))),
      codeOf(fetchedFile(fetchOf(script.transport, "https://other.example/a"))),
      codeOf(fetchedFile(fetchOf(script.transport, "not a url"))),
    ]);

    expect(codes.map((code): unknown => Reflect.get(Object(code), "code"))).toEqual([
      "a2a.file-url-not-allowed",
      "a2a.file-origin-denied",
      "a2a.file-origin-denied",
      "a2a.file-url-invalid",
    ]);
    expect(script.asked).toEqual([]);
  });

  it("a body past maxBytes stops the read at once: a2a.file-too-large, the connection cancelled", async () => {
    const script = scriptedTransport({ [`${ORIGIN}/big`]: { body: new Uint8Array(70 * 1024) } });

    const code = await codeOf(fetchedFile(fetchOf(script.transport, `${ORIGIN}/big`)));

    expect(code).toMatchObject({ code: "a2a.file-too-large" });
    expect(script.cancelled).toEqual([`${ORIGIN}/big`]);
  });

  it("the request's end and the fetch timeout abort the fetch: a2a.file-fetch-failed", async () => {
    const clock = new VirtualClock(new Date("2026-01-05T09:00:00.000Z"));
    const seen: AbortSignal[] = [];
    const hanging: FileFetch["transport"] = (_url, signal) => {
      seen.push(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          reject(new Error("aborted"));
        });
      });
    };
    const closed = new AbortController();

    const timed = codeOf(fetchedFile(fetchOf(hanging, `${ORIGIN}/a`, { clock })));
    const hungUp = codeOf(fetchedFile(fetchOf(hanging, `${ORIGIN}/b`, { signal: closed.signal })));
    await clock.advance(seconds(10));
    closed.abort();

    expect(await timed).toMatchObject({ code: "a2a.file-fetch-failed" });
    expect(await hungUp).toMatchObject({ code: "a2a.file-fetch-failed" });
    expect(seen.every((signal) => signal.aborted)).toBe(true);
  });
});

describe("#859: the file options and the body they need", () => {
  it("a skill's own fields over the application's over the defaults", () => {
    const limits = fileLimitsOf({ maxFiles: 2, maxFileSize: kilobytes(8) }, { maxFiles: 1 });

    expect(limits).toEqual({ ...DEFAULT_A2A_FILE_LIMITS, maxFiles: 1, maxFileSize: kilobytes(8) });
  });

  it("[a2a.file-options-invalid]: sizes and counts whole from 1, lower-case types, https: origins", () => {
    const violations = fileOptionsViolations(
      "app",
      {
        maxFileSize: kilobytes(0),
        maxTotalFileSize: 1.5 as never,
        maxFiles: 0,
        allowedMediaTypes: ["Image/PNG", "pdf"],
        allowedFileOrigins: ["http://a.example", "https://a.example/path", "https://ok.example"],
      },
      ["app"],
    );

    expect(violations.map((each) => each.code)).toEqual(Array(7).fill("a2a.file-options-invalid"));
    expect(fileOptionsViolations("app", undefined, ["app"])).toEqual([]);
  });

  it("maxBodySize: as given, else 1 MB, else room for the largest maxTotalFileSize as base64", () => {
    const skill = (maxTotalFileSize: Bytes, takesFiles = true) => ({
      inputFiles: takesFiles ? [{ name: "file", isList: false, isOptional: false }] : [],
      fileLimits: { ...DEFAULT_A2A_FILE_LIMITS, maxTotalFileSize },
    });

    expect(maxBodySizeOf(kilobytes(10), [skill(kilobytes(4096))])).toBe(kilobytes(10));
    expect(maxBodySizeOf(undefined, [skill(kilobytes(64))])).toBe(kilobytes(1024));
    expect(maxBodySizeOf(undefined, [skill(kilobytes(4096), false)])).toBe(kilobytes(1024));
    expect(maxBodySizeOf(undefined, [skill(kilobytes(3072))])).toBe(
      Math.ceil((kilobytes(3072) * 4) / 3) + kilobytes(256),
    );
  });
});
