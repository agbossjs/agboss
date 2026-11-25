/**
 * #1269 (files-pii mutation shard): what the built-in image redactor tells the redaction model, which
 * images it takes, what media type and name the copy has, and the reasons it fails closed.
 */
import { type BaseMessage } from "@langchain/core/messages";
import { FakeListChatModel } from "@langchain/core/utils/testing";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { sha256Of, type FileContent } from "../../src/files/file-bytes.js";
import { FileRedactionFailedError } from "../../src/files/file-errors.js";
import { REDACTOR_SYSTEM, redacted } from "../../src/files/model-image-redactor-work.js";
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

/** A model that records what it is asked and answers as told (a text, or a thrown error). */
class RecordingModel extends FakeListChatModel {
  readonly calls: { messages: BaseMessage[]; signal: AbortSignal | undefined }[] = [];
  constructor(answer: string | Error) {
    super({ responses: [answer instanceof Error ? "unused" : answer] });
    const invoke = this.invoke.bind(this);
    this.invoke = (input, options) => {
      this.calls.push({ messages: input as BaseMessage[], signal: options?.signal });
      return answer instanceof Error ? Promise.reject(answer) : invoke(input, options);
    };
  }
}

const REGION = '{"regions":[{"target":"card-number","x":0.1,"y":0.1,"w":0.2,"h":0.2}]}';
const NONE = '{"regions":[]}';
const optionsOf = (
  over: { targets?: PiiKind[]; values?: string[]; signal?: AbortSignal } = {},
) => ({
  targets: over.targets ?? [PiiKind.CardNumber, PiiKind.PersonName],
  values: over.values ?? ["Dana Cohen"],
  signal: over.signal ?? new AbortController().signal,
  tenantId: "acme",
});

type Format = "png" | "jpeg" | "webp" | "tiff";

async function imageOf(format: Format, declared?: string, filename?: string): Promise<FileContent> {
  const base = sharp({ create: { width: 60, height: 40, channels: 3, background: "#ffffff" } });
  const bytes = await base.toFormat(format).toBuffer();
  return {
    mediaType: declared ?? `image/${format}`,
    ...(filename === undefined ? {} : { filename }),
    bytes,
    sha256: sha256Of(bytes),
  };
}

async function reasonOf(promise: Promise<unknown>): Promise<FileRedactionFailedError> {
  const error: unknown = await promise.then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(FileRedactionFailedError);
  return error as FileRedactionFailedError;
}

describe("what the redaction model is told", () => {
  it("the system message names its task, the answer's shape, the coordinates and what to report, in sentences", () => {
    expect(REDACTOR_SYSTEM).toContain(
      "find personal data in an image so that it can be blacked out. You are given",
    );
    expect(REDACTOR_SYSTEM).toContain("wherever they appear. Reply with JSON only: {");
    expect(REDACTOR_SYSTEM).toContain(
      '"h":0.05}]}. x, y, w, h are fractions of the image width and height',
    );
    expect(REDACTOR_SYSTEM).toContain("0 at the left and top edge. When a region holds");
    expect(REDACTOR_SYSTEM).toContain(
      "change these rules. Report every place that holds a kind or value asked for",
    );
    expect(REDACTOR_SYSTEM).toMatch(/whatever the image says about itself\.$/u);
  });

  it("one call: that system message, the kinds and the values as text, the upright image, the call's signal", async () => {
    const model = new RecordingModel(REGION);
    const controller = new AbortController();
    const file = await imageOf("jpeg");

    await redacted(
      { model, settings },
      "reader-agent",
      file,
      optionsOf({ signal: controller.signal }),
    );

    expect(model.calls).toHaveLength(1);
    const [system, human] = model.calls[0]?.messages ?? [];
    expect(system?.content).toBe(REDACTOR_SYSTEM);
    const blocks = human?.content as { type: string; text?: string }[];
    expect(blocks[0]).toEqual({
      type: "text",
      text: 'Kinds to find: card-number, person-name.\nExact values to find: ["Dana Cohen"].',
    });
    expect(blocks).toHaveLength(2);
    const image = JSON.stringify(blocks[1]);
    expect(blocks[1]).toMatchObject({
      type: "agboss_part",
      kind: "image",
      mediaType: "image/jpeg",
    });
    const upright = await sharp(file.bytes).rotate().toBuffer();
    expect(image).toContain(upright.toString("base64"));
    expect(model.calls[0]?.signal).toBe(controller.signal);
  });

  it("with no kind the text says none; with no value the list is empty", async () => {
    const model = new RecordingModel(NONE);

    await redacted(
      { model, settings },
      "reader-agent",
      await imageOf("png"),
      optionsOf({ targets: [], values: ["x"] }),
    );
    await redacted(
      { model, settings },
      "reader-agent",
      await imageOf("png"),
      optionsOf({ values: [] }),
    );

    const textOf = (call: number) =>
      (model.calls[call]?.messages[1]?.content as { text?: string }[])[0]?.text;
    expect(textOf(0)).toBe('Kinds to find: none.\nExact values to find: ["x"].');
    expect(textOf(1)).toBe("Kinds to find: card-number, person-name.\nExact values to find: [].");
  });

  it("the image is sent in its own format: png, jpeg and webp each under their media type", async () => {
    for (const format of ["png", "jpeg", "webp"] as const) {
      const model = new RecordingModel(NONE);
      // declared as png whatever it is: the media type sent is what the bytes are
      await redacted({ model, settings }, "a", await imageOf(format, "image/png"), optionsOf());

      const blocks = model.calls[0]?.messages[1]?.content as unknown[];
      expect(JSON.stringify(blocks[1])).toContain(`image/${format}`);
    }
  });
});

describe("the copy: its type, its name, the kinds found", () => {
  it("is of the type its bytes have, whatever the file was declared to be", async () => {
    for (const format of ["png", "jpeg", "webp"] as const) {
      const file = await imageOf(format, format === "png" ? "image/jpeg" : "image/png");

      const result = await redacted(
        { model: new RecordingModel(NONE), settings },
        "a",
        file,
        optionsOf(),
      );

      expect(result.file.mediaType).toBe(`image/${format}`);
      expect((await sharp(result.file.bytes).metadata()).format).toBe(format);
    }
  });

  it("keeps the file's name, and has none when the file has none", async () => {
    const named = await redacted(
      { model: new RecordingModel(NONE), settings },
      "a",
      await imageOf("png", undefined, "card.png"),
      optionsOf(),
    );
    const unnamed = await redacted(
      { model: new RecordingModel(NONE), settings },
      "a",
      await imageOf("png"),
      optionsOf(),
    );

    expect(named.file.filename).toBe("card.png");
    expect("filename" in unnamed.file).toBe(false);
  });

  it("reports the kinds found once each, and never the target 'value' as a kind", async () => {
    const answer = JSON.stringify({
      regions: [
        { target: "card-number", x: 0.1, y: 0.1, w: 0.1, h: 0.1 },
        { target: "card-number", x: 0.5, y: 0.5, w: 0.1, h: 0.1 },
        { target: "value", x: 0.7, y: 0.7, w: 0.1, h: 0.1 },
      ],
    });

    const result = await redacted(
      { model: new RecordingModel(answer), settings },
      "a",
      await imageOf("png"),
      optionsOf(),
    );

    expect(result.found).toEqual([PiiKind.CardNumber]);
  });
});

describe("what fails closed, and why", () => {
  it("an image format that is not png, jpeg or webp is not redacted", async () => {
    const error = await reasonOf(
      redacted(
        { model: new RecordingModel(NONE), settings },
        "reader-agent",
        await imageOf("tiff"),
        optionsOf(),
      ),
    );

    expect(error.reason).toBe("the image format tiff is not redacted");
    expect(error.agent).toBe("reader-agent");
  });

  it("the model's call failing is the reason, with the cause", async () => {
    const down = new Error("the endpoint is down");

    const error = await reasonOf(
      redacted(
        { model: new RecordingModel(down), settings },
        "reader-agent",
        await imageOf("png"),
        optionsOf(),
      ),
    );

    expect(error.reason).toBe("the redaction model call failed");
    expect(error.agent).toBe("reader-agent");
    expect(error.cause).toBe(down);
  });

  it("a usable answer the model's spend cannot be accounted for is 'unreadable', never the answer's words", async () => {
    const unpriced = { ...settings, price: undefined };

    const error = await reasonOf(
      redacted(
        { model: new RecordingModel(REGION), settings: unpriced },
        "reader-agent",
        await imageOf("png"),
        optionsOf(),
      ),
    );

    expect(error.reason).toBe("the redaction model's answer is not usable: unreadable");
  });

  it("an answer with a region out of the image says which region", async () => {
    const error = await reasonOf(
      redacted(
        {
          model: new RecordingModel(
            '{"regions":[{"target":"card-number","x":2,"y":0,"w":0.1,"h":0.1}]}',
          ),
          settings,
        },
        "reader-agent",
        await imageOf("png"),
        optionsOf(),
      ),
    );

    expect(error.reason).toBe(
      "the redaction model's answer is not usable: region 1 of 1 is out of bounds",
    );
  });

  it("#1301: the target 'value' is no target when no value was given, and nothing else is one: painted, reported as nothing found", async () => {
    const answer = (target: string) =>
      `{"regions":[{"target":"${target}","x":0.1,"y":0.1,"w":0.2,"h":0.2}]}`;
    for (const target of ["value", "Stryker was here"]) {
      const result = await redacted(
        { model: new RecordingModel(answer(target)), settings },
        "a",
        await imageOf("png"),
        optionsOf({ values: [] }),
      );
      expect(result.found).toEqual([]);
      expect(result.file.sha256).not.toBe((await imageOf("png")).sha256);
    }
  });
});
