/**
 * #1269 (files-pii mutation shard): the redactor decodes under the pixel cap on every read, and paints
 * the pixels of a box — and only those — black and opaque, an alpha channel included.
 */
import { FakeListChatModel } from "@langchain/core/utils/testing";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import { sha256Of, type FileContent } from "../../src/files/file-bytes.js";
import { redacted } from "../../src/files/model-image-redactor-work.js";
import { PiiKind } from "../../src/pii/kinds.js";
import { seconds } from "../../src/units/index.js";
import { usd } from "../../src/units/index.js";

const { optionsSeen } = vi.hoisted(() => ({ optionsSeen: [] as unknown[] }));

/** sharp as it is, recording the options of every call. */
vi.mock("sharp", async (importOriginal) => {
  const actual = await importOriginal<{ default: (...args: unknown[]) => object }>();
  const wrapped = (input: unknown, options?: unknown) => {
    optionsSeen.push(options);
    return actual.default(input, options);
  };
  return { ...actual, default: wrapped };
});

const settings = {
  model: "test/redactor",
  temperature: 0,
  maxTokens: 100,
  thinking: "default" as const,
  cache: true,
  timeout: seconds(1),
  maxRetries: 0,
  price: { inputPerMillion: usd(1), outputPerMillion: usd(1) },
};

const REGION = '{"regions":[{"target":"card-number","x":0.25,"y":0.25,"w":0.5,"h":0.5}]}';
const options = () => ({
  targets: [PiiKind.CardNumber],
  values: [],
  signal: new AbortController().signal,
  tenantId: "acme",
});

async function imageOf(channels: 3 | 4): Promise<FileContent> {
  const background =
    channels === 4 ? { r: 255, g: 255, b: 255, alpha: 0.5 } : { r: 255, g: 255, b: 255 };
  const bytes = await sharp({ create: { width: 40, height: 40, channels, background } })
    .png()
    .toBuffer();
  return { mediaType: "image/png", bytes, sha256: sha256Of(bytes) };
}

describe("the pixel cap", () => {
  it("every read of the image's pixels is under the cap; the header read has none", async () => {
    optionsSeen.length = 0;
    const model = new FakeListChatModel({ responses: [REGION] });

    await redacted({ model, settings }, "a-agent", await imageOf(3), options(), {
      maxPixels: 5000,
      maxRegions: 10,
    });

    const calls = optionsSeen.slice(1); // the first is this test's own image
    expect(calls).toEqual([
      undefined,
      { limitInputPixels: 5000 },
      { limitInputPixels: 5000 },
      { raw: { width: 40, height: 40, channels: 3 }, limitInputPixels: 5000 },
    ]);
  });
});

describe("the painted box", () => {
  it("is black and opaque; every pixel outside it is as it was, its alpha too", async () => {
    const model = new FakeListChatModel({ responses: [REGION] });

    const copy = await redacted({ model, settings }, "a-agent", await imageOf(4), options());

    const { data, info } = await sharp(copy.file.bytes).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(4);
    let painted = 0;
    for (let at = 0; at < data.length; at += 4) {
      const pixel = [...data.subarray(at, at + 4)];
      if (pixel[0] === 0) {
        painted += 1;
        expect(pixel).toEqual([0, 0, 0, 255]);
      } else {
        expect(pixel).toEqual([255, 255, 255, 128]);
      }
    }
    expect(painted).toBeGreaterThan(100);
    expect(painted).toBeLessThan(40 * 40);
  });

  it("is plain black in an image with no alpha channel", async () => {
    const model = new FakeListChatModel({ responses: [REGION] });

    const copy = await redacted({ model, settings }, "a-agent", await imageOf(3), options());

    const { data, info } = await sharp(copy.file.bytes).raw().toBuffer({ resolveWithObject: true });
    expect(info.channels).toBe(3);
    const pixels = Array.from({ length: data.length / 3 }, (_, at) => [
      ...data.subarray(at * 3, at * 3 + 3),
    ]);
    const painted = pixels.filter((pixel) => pixel[0] !== 255);
    expect(painted.length).toBeGreaterThan(100);
    expect(painted.every((pixel) => pixel.every((channel) => channel === 0))).toBe(true);
  });
});
