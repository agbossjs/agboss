/**
 * #899 §5, §6 (AC3): the built-in image redactor on real images — the regions the model names are painted
 * black in a copy that is upright and has no metadata; everything that goes wrong fails closed, never the
 * unredacted file.
 */
import { FakeListChatModel } from "@langchain/core/utils/testing";
import sharp from "sharp";
import { crc32, deflateSync } from "node:zlib";
import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { sha256Of, type FileContent } from "../../src/files/file-bytes.js";
import { FileRedactionFailedError } from "../../src/files/file-errors.js";
import {
  MAX_INPUT_PIXELS,
  REDACTOR_SYSTEM,
  redacted,
} from "../../src/files/model-image-redactor-work.js";
import { boxOf, MAX_REGIONS, regionsOf } from "../../src/files/redaction-regions.js";
import { SILENT_LOG } from "../../src/infrastructure/logger.js";
import { PiiKind } from "../../src/pii/kinds.js";
import { seconds } from "../../src/units/index.js";
import { runNodeReporting } from "../helpers/process.js";

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
  it("the model's answer is no JSON, or has no list", async () => {
    await failure("I found a card.");
    await failure('{"regions":"all"}');
  });

  it("#1301: a region whose target nobody asked for is painted all the same, the file is not refused, and the log hears of it", async () => {
    const file = await imageOf(undefined, "jpeg");
    const answer = '{"regions":[{"target":"email","x":0.5,"y":0.5,"w":0.1,"h":0.1}]}';
    const warned: { code: string; message: string }[] = [];
    const log = {
      ...SILENT_LOG,
      warn: (code: string, message: string) => warned.push({ code, message }),
    };

    const result = await redacted(
      bindingAnswering(answer),
      "reader-agent",
      file,
      OPTIONS,
      undefined,
      log,
    );

    expect(Math.max(...(await pixelAt(result.file.bytes, 105, 52)))).toBeLessThan(10);
    expect(result.found).toEqual([]);
    expect(warned).toEqual([
      {
        code: "files.redactor-unknown-target",
        message:
          "reader-agent: the redaction model named 1 region(s) with a target it was not asked for — painted all the same",
      },
    ]);
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

  it("#1301: the target 'value' is only known when values were given: without them it is painted and warned", async () => {
    const warned: string[] = [];
    const log = { ...SILENT_LOG, warn: (code: string) => warned.push(code) };

    await redacted(
      bindingAnswering('{"regions":[{"target":"value","x":0.1,"y":0.1,"w":0.2,"h":0.2}]}'),
      "reader-agent",
      await imageOf(),
      { ...OPTIONS, values: [] },
      undefined,
      log,
    );

    expect(warned).toEqual(["files.redactor-unknown-target"]);
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
    ).toContain("more than 40000000 pixels");
  });
});

describe("AC3: the regions' rules and padding", () => {
  const known = new Set(["card-number", "value"]);

  it("regionsOf takes a JSON in a code fence, and keeps the numbers as given", () => {
    const [region] = regionsOf(`\`\`\`json\n${REGION}\n\`\`\``, known);

    expect(region).toEqual({ target: "card-number", x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
  });

  it("a box of a line is padded by 10 % along it and half its height above and below, clamped to the image", () => {
    const box = boxOf({ target: "card-number", x: 0.1, y: 0.1, w: 0.5, h: 0.04 }, 1000, 1000);
    expect([box.left, box.top]).toEqual([50, 80]);
    // 10 % of 500 px each way
    expect(box.width).toBeGreaterThanOrEqual(600);
    expect(box.width).toBeLessThanOrEqual(601);
    // half a region's height above and below: 0.04 × 1000 = 40 px → 20 px each way
    expect(box.height).toBeGreaterThanOrEqual(80);
    expect(box.height).toBeLessThanOrEqual(81);
    const edge = boxOf({ target: "card-number", x: 0.95, y: 0.95, w: 0.5, h: 0.5 }, 200, 100);
    expect(edge.left + edge.width).toBeLessThanOrEqual(200);
    expect(edge.top + edge.height).toBeLessThanOrEqual(100);
    const corner = boxOf({ target: "card-number", x: 0, y: 0, w: 0.2, h: 0.02 }, 200, 100);
    expect([corner.left, corner.top]).toEqual([0, 0]);
  });
});

describe("AC3: the padding is bounded where it would wipe out the image, and floored where a short token would be clipped", () => {
  it("a tall block pads at most 5 % of the image's height above and below; a line (up to 10 % tall) keeps its half line", () => {
    const tall = boxOf({ target: "address", x: 0.1, y: 0.4, w: 0.5, h: 0.3 }, 1000, 1000);
    // 0.3 tall + 0.05 above + 0.05 below = 0.4 of 1000 px
    expect(tall.top).toBe(350);
    expect(tall.height).toBeGreaterThanOrEqual(400);
    expect(tall.height).toBeLessThanOrEqual(401);
    const line = boxOf({ target: "card-number", x: 0.1, y: 0.5, w: 0.4, h: 0.1 }, 1000, 1000);
    // half a line each way: 0.05
    expect(line.top).toBe(450);
    expect(line.height).toBeGreaterThanOrEqual(200);
    expect(line.height).toBeLessThanOrEqual(201);
  });

  it("a short token (a CVV) is padded sideways by at least a quarter of its height, so a box a little off keeps no digit out", () => {
    const cvv = boxOf({ target: "card-number", x: 0.5, y: 0.5, w: 0.025, h: 0.02 }, 1000, 1000);
    // w × 10 % = 2.5 px would clip a digit; a quarter of the height is 5 px each way
    expect(cvv.left).toBe(495);
    expect(cvv.width).toBeGreaterThanOrEqual(35);
    expect(cvv.width).toBeLessThanOrEqual(36);
  });
});

describe("AC3: the redaction model is told to name the kind, so a blocked kind is never read as a value", () => {
  it('a region that holds a listed kind carries the kind\'s name; "value" is only for a value that is none of the kinds', () => {
    expect(REDACTOR_SYSTEM).toContain("kind's own name");
    expect(REDACTOR_SYSTEM).toMatch(/"value" only when/u);
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

  it("a target that is the model's own text is painted and never in the log line", async () => {
    const warned: string[] = [];
    const log = {
      ...SILENT_LOG,
      warn: (code: string, message: string) => warned.push(`${code} ${message}`),
    };

    await redacted(
      bindingAnswering(`{"regions":[{"target":"${SECRET}","x":0.1,"y":0.1,"w":0.2,"h":0.2}]}`),
      "reader-agent",
      await imageOf(),
      OPTIONS,
      undefined,
      log,
    );

    expect(warned).toHaveLength(1);
    expect(warned.join("\n")).not.toContain("Dana");
    expect(warned.join("\n")).not.toContain("4242");
  });

  it("the reason says which region and what is wrong, with the counts", async () => {
    const error = await failure(
      '{"regions":[{"target":"card-number","x":0.1,"y":0.1,"w":0.2,"h":0.2},{"target":"card-number","x":0.1,"y":0.1,"w":0.2,"h":9}]}',
    );

    expect(error.reason).toContain("region 2 of 2 is out of bounds");
  });
});

const pngChunk = (name: string, data: Buffer): Buffer => {
  const type = Buffer.from(name);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([length, type, data, crc]);
};

/** A PNG whose header claims `width` x `height` and whose data is 10 zero bytes: nothing like that many pixels to decode. */
function headerOnlyPng(width: number, height: number): FileContent {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const bytes = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(Buffer.alloc(10))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  return { mediaType: "image/png", bytes, sha256: sha256Of(bytes) };
}

const regionsOfCount = (count: number): string =>
  JSON.stringify({
    regions: Array.from({ length: count }, (_, at) => ({
      target: "card-number",
      x: (at % 10) / 12,
      y: 0.1,
      w: 0.05,
      h: 0.1,
    })),
  });

describe("#1257: the work is bound by the image's header and the number of regions", () => {
  it("the size in the header is checked before a pixel is decoded: a header alone is refused for its pixels", async () => {
    const model = bindingAnswering(REGION);
    const invoke = vi.spyOn(model.model, "invoke");

    const error = await redacted(model, "reader-agent", headerOnlyPng(7000, 7000), OPTIONS).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(FileRedactionFailedError);
    expect((error as FileRedactionFailedError).reason).toContain("more than 40000000 pixels");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("an image of exactly the limit is read; one pixel more is not", async () => {
    const file = await imageOf();

    const read = await redacted(bindingAnswering(REGION), "reader-agent", file, OPTIONS, {
      maxPixels: 200 * 100,
      maxRegions: MAX_REGIONS,
    });
    const refused = await redacted(bindingAnswering(REGION), "reader-agent", file, OPTIONS, {
      maxPixels: 200 * 100 - 1,
      maxRegions: MAX_REGIONS,
    }).catch((thrown: unknown) => thrown);

    expect(read.found).toEqual([PiiKind.CardNumber]);
    expect(refused).toBeInstanceOf(FileRedactionFailedError);
    expect((refused as FileRedactionFailedError).reason).toContain("more than 19999 pixels");
  });

  it("the cap on regions is 200: 200 are painted, 201 fail the redaction with their count and none of the answer", async () => {
    expect(MAX_REGIONS).toBe(200);
    const ok = await redacted(
      bindingAnswering(regionsOfCount(MAX_REGIONS)),
      "reader-agent",
      await imageOf(),
      OPTIONS,
    );
    const error = await failure(regionsOfCount(MAX_REGIONS + 1));

    expect(ok.found).toEqual([PiiKind.CardNumber]);
    expect(error.reason).toContain("201 regions, more than the 200 taken");
  });

  it("a limit given for the regions is the cap", async () => {
    const error = await redacted(
      bindingAnswering(regionsOfCount(3)),
      "reader-agent",
      await imageOf(),
      OPTIONS,
      { maxPixels: MAX_INPUT_PIXELS, maxRegions: 2 },
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(FileRedactionFailedError);
    expect((error as FileRedactionFailedError).reason).toContain(
      "3 regions, more than the 2 taken",
    );
  });

  it("every region is painted in the one buffer: many boxes, each black, the rest of the image untouched", async () => {
    const regions = Array.from({ length: 100 }, (_, at) => ({
      target: "card-number",
      x: (at % 10) / 10 + 0.02,
      y: Math.floor(at / 10) / 10 + 0.02,
      w: 0.03,
      h: 0.03,
    }));

    const result = await redacted(
      bindingAnswering(JSON.stringify({ regions })),
      "reader-agent",
      await imageOf(),
      OPTIONS,
    );

    for (const region of [regions[0], regions[37], regions[99]])
      expect(
        await pixelAt(
          result.file.bytes,
          Math.floor((region?.x ?? 0) * 200) + 2,
          Math.floor((region?.y ?? 0) * 100) + 1,
        ),
      ).toEqual([0, 0, 0]);
    expect(await pixelAt(result.file.bytes, 199, 99)).toEqual([255, 255, 255]);
  });

  it("a box is black to its last pixel on every side and no further", async () => {
    const file = await imageOf();
    const region = { target: "card-number", x: 0.4, y: 0.3, w: 0.2, h: 0.2 };
    const box = boxOf(region, 200, 100);
    const answer = JSON.stringify({ regions: [region] });

    const result = await redacted(bindingAnswering(answer), "reader-agent", file, OPTIONS);

    const right = box.left + box.width;
    const bottom = box.top + box.height;
    for (const [x, y] of [
      [box.left, box.top],
      [right - 1, bottom - 1],
      [box.left, bottom - 1],
      [right - 1, box.top],
    ] as const)
      expect(await pixelAt(result.file.bytes, x, y)).toEqual([0, 0, 0]);
    for (const [x, y] of [
      [box.left - 1, box.top],
      [right, bottom - 1],
      [box.left, box.top - 1],
      [right - 1, bottom],
    ] as const)
      expect(await pixelAt(result.file.bytes, x, y)).toEqual([255, 255, 255]);
  });

  it("an alpha channel is opaque under a box and kept elsewhere; grey stays grey", async () => {
    const pixels = (_channels: 2 | 4, value: number[]) =>
      Buffer.from(Array.from({ length: 20 * 20 }, () => value).flat());
    const rgba = await sharp(pixels(4, [200, 10, 10, 0]), {
      raw: { width: 20, height: 20, channels: 4 },
    })
      .png()
      .toBuffer();
    const grey = await sharp(pixels(2, [200, 255]), { raw: { width: 20, height: 20, channels: 2 } })
      .png()
      .toBuffer();
    const answer = '{"regions":[{"target":"card-number","x":0.0,"y":0.0,"w":0.5,"h":0.5}]}';

    for (const bytes of [rgba, grey]) {
      const result = await redacted(
        bindingAnswering(answer),
        "reader-agent",
        { mediaType: "image/png", bytes, sha256: sha256Of(bytes) },
        OPTIONS,
      );
      const { data, info } = await sharp(result.file.bytes)
        .raw()
        .toBuffer({ resolveWithObject: true });
      const at = (x: number, y: number) => (y * info.width + x) * info.channels;
      expect(data[at(2, 2)]).toBe(0);
      expect(data[at(2, 2) + info.channels - 1]).toBe(255);
      expect(data[at(19, 19) + info.channels - 1]).toBe(bytes === rgba ? 0 : 255);
    }
  });

  it("a 40 MP image of 18 KiB with 200 model-given regions stays in one full-size buffer: peak memory under 700 MB", async () => {
    const run = await runNodeReporting(
      ["--import", "tsx", new URL("redactor-bound-process.ts", import.meta.url).pathname, "200"],
      { env: process.env },
    );
    if (run.status !== 0) throw new Error(`the process failed:\n${run.stderr}`);

    const { peakMb } = run.messages[0] as { peakMb: number };

    // per region the redactor allocated a buffer of its box: 1392 MB for the same run before #1257
    expect(peakMb).toBeLessThan(700);
  }, 60_000);
});
