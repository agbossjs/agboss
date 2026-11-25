import { usd } from "../../src/units/index.js";
/**
 * #1269 (mutation shard files-pii): `viewOf` in the transcription view — what is kept for the cache and
 * what is not, the transcriber's call and its spend, the masking's spend, and the file as the model saw it.
 */
import { describe, expect, it } from "vitest";
import type { FileContent } from "../../src/files/file-bytes.js";
import { sha256Of } from "../../src/files/file-bytes.js";
import type { FileMask, MaskedFileText } from "../../src/files/file-mask.js";
import { resolvedFilesOf } from "../../src/files/file-settings.js";
import { transcriptKeyOf, viewOf } from "../../src/files/file-views.js";
import { FileView } from "../../src/files/model-files.js";
import type { FileBatch, FileRuntime } from "../../src/files/visit-files.js";
import { CostSource } from "../../src/finops/cost-source.js";
import type { UsageRecord } from "../../src/finops/usage.js";
import { megabytes } from "../../src/units/index.js";
import { PNG } from "../a2a/files/support.js";
import { NO_REDACTION } from "./runtime-parts.js";
import { DEFAULT_FILE_LIMITS } from "../../src/files/file-policy.js";

const usageOf = (caller: string): UsageRecord => ({
  provider: "test-provider",
  caller,
  model: "m/x",
  costUsd: usd(0.5),
  costSource: CostSource.Api,
  inputTokens: 1,
  outputTokens: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
});

const image = (filename?: string): FileContent => ({
  mediaType: "image/png",
  ...(filename === undefined ? {} : { filename }),
  bytes: PNG,
  sha256: sha256Of(PNG),
});

const textFile = (text: string, filename?: string): FileContent => {
  const bytes = new TextEncoder().encode(text);
  return {
    mediaType: "text/plain",
    ...(filename === undefined ? {} : { filename }),
    bytes,
    sha256: sha256Of(bytes),
  };
};

interface Calls {
  transcribed: FileContent[];
  checked: number;
}

function setup(
  options: {
    usage?: UsageRecord;
    said?: string;
    mask?: (text: string) => MaskedFileText;
    cache?: Record<string, string>;
  } = {},
) {
  const calls: Calls = { transcribed: [], checked: 0 };
  const runtime: FileRuntime = {
    agent: "reader",
    settings: resolvedFilesOf({
      agent: {},
      defaults: undefined,
      limits: DEFAULT_FILE_LIMITS,
      hasPiiPolicy: false,
    }),
    maxResultSize: megabytes(1),
    context: () => {
      throw new Error("no reads in this test");
    },
    transcribe: (file) => {
      calls.transcribed.push(file);
      return Promise.resolve({
        text: options.said ?? "what the image says",
        ...(options.usage === undefined ? {} : { usage: options.usage }),
      });
    },
    transcriberKey: () => "tk",
    ...NO_REDACTION,
  };
  const { mask } = options;
  const fileMask: FileMask | undefined =
    mask === undefined
      ? undefined
      : {
          policyHash: "ph",
          known: {},
          mask: (text) => Promise.resolve(mask(text)),
          redaction: { kinds: [], values: [], blocked: [], isModelChecked: false },
          redactionDigestOf: () => "d",
          maskCacheKeyOf: (text) => `k:${text}`,
          refusalForKind: () => Promise.resolve(undefined),
        };
  const batch: FileBatch = {
    runtime,
    files: [],
    tally: { count: 0, bytes: 0 },
    cache: options.cache ?? {},
    first: 1,
    mask: fileMask,
    beforeModelCall: () => {
      calls.checked += 1;
    },
  };
  return { batch, calls, runtime };
}

describe("a transcription view: what the transcriber's call costs and leaves", () => {
  it("the transcriber is asked once, the budgets checked before it, and what it said is kept under the key", async () => {
    const { batch, calls, runtime } = setup({ usage: usageOf("files:transcriber") });
    const content = image("scan.png");

    const result = await viewOf(batch, content, FileView.Transcription, "H", {});

    expect(calls.checked).toBe(1);
    expect(calls.transcribed).toEqual([content]);
    expect(result.made?.entry).toBe("what the image says");
    expect(result.made?.key).toBe(transcriptKeyOf(runtime, content, ""));
    expect(result.made?.key).toBe(`${content.sha256}:tk:4096:`);
    expect(result.usage).toEqual([usageOf("files:transcriber")]);
    expect(result.tokens).toEqual({});
  });

  it("a transcriber that reports no usage adds none", async () => {
    const { batch } = setup();

    const result = await viewOf(batch, image(), FileView.Transcription, "H", {});

    expect(result.usage).toEqual([]);
    expect(result.made?.entry).toBe("what the image says");
  });

  it("the file as the model saw it is the text, as text/plain, keeping the name; the pieces show it under the heading", async () => {
    const { batch } = setup();

    const named = await viewOf(batch, image("scan.png"), FileView.Transcription, "H", {});
    const anonymous = await viewOf(batch, image(), FileView.Transcription, "H", {});

    const bytes = Buffer.from("what the image says", "utf8");
    expect(named.viewed).toEqual({
      mediaType: "text/plain",
      filename: "scan.png",
      bytes,
      sha256: sha256Of(bytes),
    });
    expect(Object.keys(anonymous.viewed).sort()).toEqual(["bytes", "mediaType", "sha256"]);
    expect(named.pieces).toEqual([{ kind: "text", text: "H\nwhat the image says" }]);
  });

  it("the text's bytes are UTF-8", async () => {
    const { batch } = setup({ cache: { [`${image().sha256}:tk:4096:`]: "héllo ✓" } });

    const result = await viewOf(batch, image(), FileView.Transcription, "H", {});

    expect([...result.viewed.bytes]).toEqual([...Buffer.from("héllo ✓", "utf8")]);
    expect(result.viewed.sha256).toBe(sha256Of(Buffer.from("héllo ✓", "utf8")));
  });
});

describe("a transcription view: what is already known is not made again", () => {
  it("a cached transcription is shown as it is: nothing asked, nothing newly kept, no spend", async () => {
    const content = image();
    const { batch, calls } = setup({ cache: { [`${content.sha256}:tk:4096:`]: "cached text" } });

    const result = await viewOf(batch, content, FileView.Transcription, "H", {});

    expect(calls.transcribed).toEqual([]);
    expect(calls.checked).toBe(0);
    expect(result.pieces).toEqual([{ kind: "text", text: "H\ncached text" }]);
    expect(Object.keys(result).sort()).toEqual(["pieces", "tokens", "usage", "viewed"]);
    expect(result.usage).toEqual([]);
  });

  it("a text format is its own transcription: no model is asked and nothing is kept for the cache", async () => {
    const { batch, calls } = setup();

    const result = await viewOf(
      batch,
      textFile("plain words", "a.txt"),
      FileView.Transcription,
      "H",
      {},
    );

    expect(calls.transcribed).toEqual([]);
    expect(calls.checked).toBe(0);
    expect(result.pieces).toEqual([{ kind: "text", text: "H\nplain words" }]);
    expect(Object.keys(result).sort()).toEqual(["pieces", "tokens", "usage", "viewed"]);
    expect(result.viewed.filename).toBe("a.txt");
  });
});

describe("a transcription view under masking", () => {
  const masking = (text: string): MaskedFileText => ({
    text: text.replace("secret", "[X]"),
    tokens: { "[X]": "secret" },
    usage: [usageOf("pii")],
  });

  it("the transcriber's spend and the masking's are both the view's; the masked text is what is kept", async () => {
    const { batch } = setup({
      usage: usageOf("files:transcriber"),
      said: "a secret",
      mask: masking,
    });

    const result = await viewOf(batch, image(), FileView.Transcription, "H", {});

    expect(result.made?.entry).toBe("a [X]");
    expect(result.made?.key).toBe(`${image().sha256}:tk:4096:ph`);
    expect(result.tokens).toEqual({ "[X]": "secret" });
    expect(result.usage).toEqual([usageOf("files:transcriber"), usageOf("pii")]);
    expect(result.pieces).toEqual([
      { kind: "text", text: "H" },
      { kind: "text", text: "a [X]", isMasked: true },
    ]);
  });

  it("a text format's own text is masked, kept masked and asks no model", async () => {
    const { batch, calls } = setup({ mask: masking });

    const result = await viewOf(batch, textFile("a secret"), FileView.Original, "H", {});

    expect(calls.transcribed).toEqual([]);
    expect(calls.checked).toBe(0);
    expect(result.made?.entry).toBe("a [X]");
    expect(result.usage).toEqual([usageOf("pii")]);
    expect(result.viewed.mediaType).toBe("text/plain");
  });
});
