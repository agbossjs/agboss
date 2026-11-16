/**
 * #899 §5, §6 (AC3): the built-in image redactor on real images — the regions the model names are painted
 * black in a copy that is upright and has no metadata; everything that goes wrong fails closed, never the
 * unredacted file.
 */
import { FakeListChatModel } from "@langchain/core/utils/testing";
import sharp from "sharp";
import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { sha256Of, type FileContent } from "../../src/files/file-bytes.js";
import { FileRedactionFailedError } from "../../src/files/file-errors.js";
import { MAX_INPUT_PIXELS, redacted } from "../../src/files/model-image-redactor-work.js";
import { boxOf, regionsOf } from "../../src/files/redaction-regions.js";
import { PiiKind } from "../../src/pii/kinds.js";
import { seconds } from "../../src/units/index.js";

const settings = {
  model: "test/redactor",
  temperature: 0,
  maxTokens: 100,
  thinking: "default" as const,
  cache: true,
  timeout: seconds(1),
  maxRetries: 0,
  price: { inputPerMTok: 1, outputPerMTok: 1 },
};

const bindingAnswering = (...answers: string[]) => ({
  model: new FakeListChatModel({ responses: answers }),
  settings,
});

const OPTIONS = {
  targets: [PiiKind.CardNumber, PiiKind.PersonName],
  values: ["Dana Cohen"],
  signal: new AbortController().signal,
  tenantId: "acme",
};

/** A 200 x 100 white image with a red block at x 20..60, y 10..30. */
async function imageOf(orientation?: number, format: "png" | "jpeg" = "png"): Promise<FileContent> {
  const red = await sharp({ create: { width: 40, height: 20, channels: 3, background: "#ff0000" } })
    .png()
    .toBuffer();
  const base = sharp({
    create: { width: 200, height: 100, channels: 3, background: "#ffffff" },
  }).composite([{ input: red, left: 20, top: 10 }]);
  const bytes = await (format === "png" ? base.png() : base.jpeg({ quality: 100 }))
    .withMetadata(orientation === undefined ? {} : { orientation })
    .toBuffer();
  return {
    mediaType: format === "png" ? "image/png" : "image/jpeg",
    filename: "card.png",
    bytes,
    sha256: sha256Of(bytes),
  };
}

const pixelAt = async (bytes: Uint8Array, x: number, y: number): Promise<number[]> => {
  const { data, info } = await sharp(bytes).raw().toBuffer({ resolveWithObject: true });
  const at = (y * info.width + x) * info.channels;
  return [data[at] ?? -1, data[at + 1] ?? -1, data[at + 2] ?? -1];
};

const REGION = '{"regions":[{"target":"card-number","x":0.1,"y":0.1,"w":0.2,"h":0.2}]}';

describe("AC3: the built-in redactor paints the model's regions black in a copy", () => {
  it("the region (padded) is black, the rest of the image is untouched, the found kinds are reported", async () => {
    const file = await imageOf();

    const result = await redacted(bindingAnswering(REGION), "reader-agent", file, OPTIONS);

    expect(result.found).toEqual([PiiKind.CardNumber]);
    expect(result.file.mediaType).toBe("image/png");
    expect(result.file.sha256).toBe(sha256Of(result.file.bytes));
    expect(result.file.sha256).not.toBe(file.sha256);
    expect(await pixelAt(result.file.bytes, 30, 20)).toEqual([0, 0, 0]);
    expect(await pixelAt(result.file.bytes, 190, 90)).toEqual([255, 255, 255]);
    expect(result.usage?.caller).toBe("files:redactor");
  });

  it("the copy is upright and without metadata: an EXIF orientation is applied, the tag is gone", async () => {
    const file = await imageOf(6);
    const before = await sharp(file.bytes).metadata();
    expect(before.orientation).toBe(6);

    const result = await redacted(
      bindingAnswering('{"regions":[]}'),
      "reader-agent",
      file,
      OPTIONS,
    );

    const after = await sharp(result.file.bytes).metadata();
    expect([after.width, after.height]).toEqual([100, 200]);
    expect(after.orientation).toBeUndefined();
    expect(after.exif).toBeUndefined();
  });

  it("a jpeg stays a jpeg, a value the model found is black too, an empty list is a copy with nothing hidden", async () => {
    const file = await imageOf(undefined, "jpeg");
    const answer = '{"regions":[{"target":"value","x":0.5,"y":0.5,"w":0.1,"h":0.1}]}';

    const result = await redacted(bindingAnswering(answer), "reader-agent", file, OPTIONS);

    expect(result.file.mediaType).toBe("image/jpeg");
    expect(result.found).toEqual([]);
    const pixel = await pixelAt(result.file.bytes, 105, 52);
    expect(Math.max(...pixel)).toBeLessThan(10);
  });
});

/** What the redaction must fail on, closed. */
async function failure(
  answer: string,
  file?: FileContent,
  options = OPTIONS,
): Promise<FileRedactionFailedError> {
  const error = await redacted(
    bindingAnswering(answer),
    "reader-agent",
    file ?? (await imageOf()),
    options,
  ).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(FileRedactionFailedError);
  return error as FileRedactionFailedError;
}

describe("AC3: everything that goes wrong fails closed, never the unredacted file", () => {
  it("the model's answer is no JSON, has no list, names a target nobody asked for", async () => {
    await failure("I found a card.");
    await failure('{"regions":"all"}');
    await failure('{"regions":[{"target":"email","x":0.1,"y":0.1,"w":0.2,"h":0.2}]}');
  });

  it("a region out of the image, empty, not finite or not a number is refused as a whole answer", async () => {
    const bad = [
      '{"target":"card-number","x":1,"y":0.1,"w":0.2,"h":0.2}',
      '{"target":"card-number","x":-0.1,"y":0.1,"w":0.2,"h":0.2}',
      '{"target":"card-number","x":0.1,"y":0.1,"w":0,"h":0.2}',
      '{"target":"card-number","x":0.1,"y":0.1,"w":1.5,"h":0.2}',
      '{"target":"card-number","x":"0.1","y":0.1,"w":0.2,"h":0.2}',
      '{"target":"card-number","x":0.1,"y":0.1,"w":0.2}',
    ];
    for (const region of bad) await failure(`{"regions":[${region}]}`);
    // one good region beside a bad one does not save the answer
    await failure(
      `{"regions":[{"target":"card-number","x":0.1,"y":0.1,"w":0.2,"h":0.2},${bad[0] ?? ""}]}`,
    );
  });

  it("the target 'value' is only known when values were given", async () => {
    await failure('{"regions":[{"target":"value","x":0.1,"y":0.1,"w":0.2,"h":0.2}]}', undefined, {
      ...OPTIONS,
      values: [],
    });
  });

  it("an animated (multi-frame) image is refused", async () => {
    const still = (background: string) =>
      sharp({ create: { width: 10, height: 10, channels: 3, background } })
        .png()
        .toBuffer();
    const frames = [await still("#000000"), await still("#ffffff")];
    const animated = await sharp(frames, { join: { animated: true } })
      .webp()
      .toBuffer();
    const file: FileContent = {
      mediaType: "image/webp",
      bytes: animated,
      sha256: sha256Of(animated),
    };

    const error = await failure(REGION, file);

    expect(error.reason).toContain("multi-frame");
  });

  it("bytes that are no image, and a pixel bomb, are refused before the model is asked", async () => {
    const junk: FileContent = {
      mediaType: "image/png",
      bytes: Buffer.from("not an image"),
      sha256: sha256Of(Buffer.from("not an image")),
    };
    const bomb = await sharp({
      create: { width: 8000, height: 6000, channels: 3, background: "#fff" },
    })
      .png({ compressionLevel: 9 })
      .toBuffer();
    expect(8000 * 6000).toBeGreaterThan(MAX_INPUT_PIXELS);

    expect((await failure(REGION, junk)).reason).toContain("cannot be read");
    expect(
      (await failure(REGION, { mediaType: "image/png", bytes: bomb, sha256: sha256Of(bomb) }))
        .reason,
    ).toContain("cannot be read");
  });
});

describe("AC3: the regions' rules and padding", () => {
  const known = new Set(["card-number", "value"]);

  it("regionsOf takes a JSON in a code fence, and keeps the numbers as given", () => {
    const [region] = regionsOf(`\`\`\`json\n${REGION}\n\`\`\``, known);

    expect(region).toEqual({ target: "card-number", x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
  });

  it("a box is padded by 10 % along the line and half its height above and below, clamped to the image", () => {
    const box = boxOf({ target: "card-number", x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, 200, 100);
    expect([box.left, box.top]).toEqual([16, 0]);
    expect(box.width).toBeGreaterThanOrEqual(48);
    expect(box.width).toBeLessThanOrEqual(49);
    // half a region's height above and below: 0.2 × 100 = 20 px → 10 px each way, clamped at the top edge
    expect(box.height).toBeGreaterThanOrEqual(40);
    expect(box.height).toBeLessThanOrEqual(41);
    const edge = boxOf({ target: "card-number", x: 0.95, y: 0.95, w: 0.5, h: 0.5 }, 200, 100);
    expect(edge.left + edge.width).toBeLessThanOrEqual(200);
    expect(edge.top + edge.height).toBeLessThanOrEqual(100);
  });
});

describe("AC3: nothing the model wrote reaches an error, a log or a cause", () => {
  const SECRET = "Dana Cohen 4242-4242-4242-4242";
  const everywhere = (error: unknown): string => inspect(error, { depth: null, showHidden: true });

  it("a target, a bounds failure, a non-JSON answer and a wrong shape that carry a planted secret leave no trace", async () => {
    const logged: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(String).join(" "));
      }),
    );
    const answers = [
      `{"regions":[{"target":"${SECRET}","x":0.1,"y":0.1,"w":0.2,"h":0.2}]}`,
      `{"regions":[{"target":"card-number","x":0.1,"y":0.1,"w":0.2,"h":9,"note":"${SECRET}"}]}`,
      `${SECRET} is on the card`,
      `{"regions":"${SECRET}"}`,
      `{"regions":["${SECRET}"]}`,
      `\`\`\`json\n{"regions":[{"target":"${SECRET}"}]}\n\`\`\``,
    ];
    for (const answer of answers) {
      const error = await failure(answer);
      expect(everywhere(error)).not.toContain("Dana");
      expect(everywhere(error)).not.toContain("4242");
      expect(error.reason).not.toContain("Dana");
    }
    for (const spy of spies) spy.mockRestore();
    expect(logged.join("\n")).not.toContain("Dana");
  });

  it("the reason says which region and what is wrong, with the counts", async () => {
    const error = await failure(
      '{"regions":[{"target":"card-number","x":0.1,"y":0.1,"w":0.2,"h":0.2},{"target":"nope","x":0.1,"y":0.1,"w":0.2,"h":0.2}]}',
    );

    expect(error.reason).toContain("region 2 of 2 names an unknown target");
  });
});
